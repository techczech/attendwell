import { UpdatesProvider, UpdateMarks, type UpdateActions } from '@app-patterns/updates-react';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { Icon } from './icons.tsx';

export type SessionChip = { tone: 'good' | 'warn' | 'bad' | 'off'; text: string } | null;

export function StatusBar({ left, version, update, actions, notice, chip }: {
  left: string; version: string; update: UpdateSnapshot; actions: UpdateActions; notice: string | null; chip?: SessionChip;
}): JSX.Element {
  return (
    <footer className="statusbar">
      <div className="left">
        <Icon name="folder" size={14} /><span>{left}</span>
        {chip ? <span className={`sb-chip ${chip.tone}`} role="status" aria-label={`Check-in: ${chip.text}`}><i className="dot" aria-hidden="true" />{chip.text}</span> : null}
        {notice ? <span className="notice" role="status">{notice}</span> : null}
      </div>
      <div className="right">
        <UpdatesProvider snapshot={update} actions={actions}><UpdateMarks /></UpdatesProvider>
        <span>AttendWell {version}</span>
      </div>
    </footer>
  );
}
