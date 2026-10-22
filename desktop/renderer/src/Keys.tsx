import { displayChord } from '../../shared/commands.ts';

/** A chord as separate key caps ("⌘ ⇧ P", or "Ctrl Shift P" on Windows); "—" when the command has none. */
export function Keys({ chord, platform }: { chord: string; platform: 'mac' | 'win' }): JSX.Element {
  if (!chord) return <span className="none" aria-label="No shortcut">—</span>;
  const text = displayChord(chord, platform);
  const parts = platform === 'mac' ? [...chord] : text.split('+');
  return (
    <span className="keys" aria-label={text}>
      {parts.map((p, i) => <kbd key={`${p}${i}`}>{p === '⇧' ? '⇧' : p}</kbd>)}
    </span>
  );
}
