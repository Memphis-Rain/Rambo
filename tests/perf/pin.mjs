// Q2a protocol (P1 root cause): on this 2-CCD Ryzen dev box Windows can migrate the
// renderer onto the busier CCD after ~60 s, making the same JS ~1.6x slower. Perf runs
// pin Chromium's renderer and GPU processes to CCD0 (affinity 0xFFFF) after launch.
//
// Playwright doesn't expose the browser PID, so the browser is launched with a unique,
// otherwise ignored `--rambo-pin-tag=<tag>` switch and found by its command line.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const CCD0_MASK = 0xffff;

/** Tag shared by every process of one test run (workers inherit it via the environment). */
export function pinTag() {
  if (!process.env.RAMBO_PIN_TAG) process.env.RAMBO_PIN_TAG = randomBytes(6).toString('hex');
  return process.env.RAMBO_PIN_TAG;
}

/** Chromium launch arg that marks the browser for pinRenderersToCcd0(). */
export const pinArg = () => `--rambo-pin-tag=${pinTag()}`;

/**
 * Pin the renderer and GPU processes of the tagged browser(s) to CCD0.
 * @returns {{ pinned: boolean, reason?: string, pids?: number[], affinity?: string }}
 */
export function pinRenderersToCcd0() {
  if (process.platform !== 'win32') return { pinned: false, reason: 'not Windows (no CCD pinning needed)' };
  const tag = pinTag();
  const ps = `
    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine
    $kids = @{}; foreach ($p in $all) { if (-not $kids.ContainsKey($p.ParentProcessId)) { $kids[$p.ParentProcessId] = @() }; $kids[$p.ParentProcessId] += $p }
    $roots = @($all | Where-Object { $_.CommandLine -like '*--rambo-pin-tag=${tag}*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId })
    $queue = $roots; $out = @()
    while ($queue.Count) { $id = $queue[0]; $queue = @($queue | Select-Object -Skip 1); foreach ($c in $kids[$id]) { $queue += $c.ProcessId; if ($c.CommandLine -match '--type=(renderer|gpu-process)') { $out += $c.ProcessId } } }
    foreach ($id in $out) { (Get-Process -Id $id).ProcessorAffinity = [IntPtr]${CCD0_MASK} }
    ($out | ForEach-Object { "$_=" + [int64](Get-Process -Id $_).ProcessorAffinity }) -join ','`;
  try {
    const res = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    if (!res) return { pinned: false, reason: `no renderer/gpu process found for tag ${tag}` };
    const pairs = res.split(',').map((x) => x.split('='));
    return { pinned: true, pids: pairs.map(([pid]) => Number(pid)), affinity: pairs.map(([, a]) => `0x${Number(a).toString(16)}`).join(',') };
  } catch (err) {
    return { pinned: false, reason: `pinning failed: ${err.message.split('\n')[0]}` };
  }
}
