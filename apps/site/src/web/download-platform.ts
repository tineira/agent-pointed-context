// Copied from Dock; site download links must work without a Dock source dependency.
/** UA-based offers, independent of window width: the dock itself is a narrow desktop window. */
export function downloadPlatform(userAgent: string, desktopShell: boolean) {
  const computer = !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const windows = computer && /Windows/.test(userAgent);
  return {
    computer,
    dock: windows && !desktopShell,
    pulse: windows,
    later: computer && !windows,
  };
}
