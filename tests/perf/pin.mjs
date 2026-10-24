// Q2a protocol (P1 root cause): on this 2-CCD Ryzen dev box Windows can migrate the
// renderer onto the busier CCD after ~60 s, making the same JS ~1.6x slower. Perf runs
// pin Chromium's renderer process(es) to CCD0 (affinity 0xFFFF) right after launch.
import { execFileSync } from 'node:child_process';

const CCD0_MASK = 0xffff;

/**
 * Pin every renderer child of the launched browser to CCD0.
 * @returns {{ pinned: boolean, reason?: string, pids?: number[], affinity?: string }}
 */
export function pinRenderersToCcd0(browser) {
  if (process.platform !== 'win32') return { pinned: false, reason: 'not Windows (no CCD pinning needed)' };
  const root = browser.process && browser.process();
  if (!root || !root.pid) return { pinned: false, reason: 'browser process unavailable' };
  // Renderers are descendants of the browser process with --type=renderer.
  const ps = `
    $root = ${root.pid}
    $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine
    $kids = @{}; foreach ($p in $all) { if (-not $kids.ContainsKey($p.ParentProcessId)) { $kids[$p.ParentProcessId] = @() }; $kids[$p.ParentProcessId] += $p }
    $queue = @($root); $out = @()
    while ($queue.Count) { $id = $queue[0]; $queue = $queue[1..$queue.Count]; foreach ($c in $kids[$id]) { $queue += $c.ProcessId; if ($c.CommandLine -match '--type=renderer') { $out += $c.ProcessId } } }
    foreach ($id in $out) { (Get-Process -Id $id).ProcessorAffinity = [IntPtr]${CCD0_MASK} }
    ($out | ForEach-Object { "$_=" + (Get-Process -Id $_).ProcessorAffinity }) -join ','`;
  try {
    const res = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    if (!res) return { pinned: false, reason: 'no renderer process found' };
    const pairs = res.split(',').map((x) => x.split('='));
    return { pinned: true, pids: pairs.map(([pid]) => Number(pid)), affinity: pairs.map(([, a]) => `0x${Number(a).toString(16)}`).join(',') };
  } catch (err) {
    return { pinned: false, reason: `pinning failed: ${err.message.split('\n')[0]}` };
  }
}
