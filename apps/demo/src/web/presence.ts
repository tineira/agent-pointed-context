/**
 * What one presence event does on the page, as a pure function of the settings.
 * The activity switch governs both visible traces of an agent's read: the pulse on its mark
 * and the flash on the element it read. Marks and pins stay with the switch off.
 */
export function presenceEffects(settings: { show_activity: boolean } | null | undefined): { pulse: boolean; flash: boolean } {
  const on = settings?.show_activity === true;
  return { pulse: on, flash: on };
}
