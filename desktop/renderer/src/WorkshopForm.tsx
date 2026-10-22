// The New workshop fields (title, date, start, end), shared by the first run and the New workshop sheet (⌘N).
import { useState } from 'react';
import { checkNewWorkshop, folderName, shortPath, type NewWorkshopForm } from '../../shared/workshops.ts';

export function useWorkshopForm(today: string): {
  form: NewWorkshopForm; set(patch: Partial<NewWorkshopForm>): void; errors: ReturnType<typeof checkNewWorkshop>; shown: boolean; validate(): boolean;
} {
  const [form, setForm] = useState<NewWorkshopForm>({ title: '', date: today, startTime: '', endTime: '' });
  const [shown, setShown] = useState(false);
  const errors = checkNewWorkshop(form);
  return { form, set: (patch) => setForm((f) => ({ ...f, ...patch })), errors, shown, validate: () => { setShown(true); return Object.keys(errors).length === 0; } };
}

export function WorkshopFields({ state, folderPath, home }: { state: ReturnType<typeof useWorkshopForm>; folderPath: string; home: string }): JSX.Element {
  const { form, set, errors, shown } = state;
  const err = (k: keyof typeof errors): JSX.Element | null => (shown && errors[k] ? <span className="err" role="alert">{errors[k]}</span> : null);
  return (
    <>
      <div className="field">
        <label htmlFor="wf-title">Workshop title</label>
        <input id="wf-title" autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Generative AI for Researchers" />
        {err('title')}
      </div>
      <div className="fields3">
        <div className="field"><label htmlFor="wf-date">Date</label><input id="wf-date" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />{err('date')}</div>
        <div className="field"><label htmlFor="wf-start">Starts</label><input id="wf-start" value={form.startTime} placeholder="14:00" onChange={(e) => set({ startTime: e.target.value })} />{err('startTime')}</div>
        <div className="field"><label htmlFor="wf-end">Ends</label><input id="wf-end" value={form.endTime} placeholder="16:30" onChange={(e) => set({ endTime: e.target.value })} />{err('endTime')}</div>
      </div>
      <p className="help" style={{ color: 'var(--muted)' }}>
        The folder will be {shortPath(folderPath, home)}/{folderName(form.date || 'date', form.title)}.
      </p>
    </>
  );
}
