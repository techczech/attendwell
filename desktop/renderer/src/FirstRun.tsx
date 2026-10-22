// First run: Welcome, Registers folder, First workshop (fr-welcome, fr-folder, fr-workshop). "Open the example workshop instead"
// skips setting up. Nothing is created until the last step.
import { useState } from 'react';
import { api } from './api.ts';
import iconUrl from './assets/app-icon.svg';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';
import { WorkshopFields, useWorkshopForm } from './WorkshopForm.tsx';

type Step = 'welcome' | 'folder' | 'workshop';
const STEPS: Array<{ id: Step; label: string }> = [{ id: 'welcome', label: 'Welcome' }, { id: 'folder', label: 'Registers folder' }, { id: 'workshop', label: 'First workshop' }];

export function FirstRun({ registersFolder, home, today, platform, onDone }: {
  registersFolder: string; home: string; today: string; platform: 'mac' | 'win';
  onDone(openId: string): void;
}): JSX.Element {
  const [step, setStep] = useState<Step>('welcome');
  const [folder, setFolder] = useState(registersFolder);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useWorkshopForm(today);
  const at = STEPS.findIndex((s) => s.id === step);

  const openExample = async (): Promise<void> => {
    setBusy(true); setError(null);
    const made = await api.createExample();
    if (!made.ok) { setBusy(false); setError(made.error); return; }
    await api.finishSetup();
    const opened = await api.openWorkshop(made.value.id);
    setBusy(false);
    if (!opened.ok) { setError(opened.error); return; }
    onDone(made.value.id);
  };
  const toWorkshop = async (): Promise<void> => {
    setBusy(true); setError(null);
    const r = await api.setRegistersFolder(folder);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setStep('workshop');
  };
  const create = async (): Promise<void> => {
    if (!form.validate()) return;
    setBusy(true); setError(null);
    const made = await api.createWorkshop(form.form);
    if (!made.ok) { setBusy(false); setError(made.error); return; }
    await api.finishSetup();
    const opened = await api.openWorkshop(made.value.id);
    setBusy(false);
    if (!opened.ok) { setError(opened.error); return; }
    onDone(made.value.id);
  };
  const choose = async (): Promise<void> => { const p = await api.chooseFolder(); if (p) setFolder(p); };

  return (
    <div className="firstrun">
      <aside className="fr-side">
        <div className="fr-brand"><img src={iconUrl} alt="" />AttendWell</div>
        <ol className="fr-steps" aria-label="Set up">
          {STEPS.map((s, i) => (
            <li key={s.id} className={`fr-step ${i === at ? 'on' : i < at ? 'done' : ''}`} aria-current={i === at ? 'step' : undefined}>
              <span className="n">{i < at ? <Icon name="check" size={13} /> : i + 1}</span>{s.label}
            </li>
          ))}
        </ol>
        <p className="fr-later">You can change all of this later in Settings <Keys chord="⌘," platform={platform} />.</p>
      </aside>
      <div className="fr-main">
        <div className="fr-body">
          {step === 'welcome' ? (
            <>
              <h1>Welcome to AttendWell</h1>
              <p>AttendWell keeps the register for your workshop on this laptop. People check themselves in on an iPad at the door, and you see who has arrived as they do.</p>
              <div className="fr-cards">
                <div className="fr-card"><Icon name="laptop" size={22} /><b>This laptop</b><span>Holds the register. Nothing is uploaded; only the iPads you pair can reach the check-in page.</span></div>
                <div className="fr-card"><Icon name="tablet" size={22} /><b>An iPad with the Check-in app</b><span>Paired once by scanning a code on this screen. It keeps check-ins if the Wi-Fi drops.</span></div>
                <div className="fr-card"><Icon name="wifi" size={22} /><b>Internet at the venue</b><span>When a session starts, AttendWell opens a temporary public address so the iPad can reach this laptop. No account is needed.</span></div>
              </div>
              <p className="fr-note">Setting up takes two short steps: where to keep registers, and your first workshop.</p>
            </>
          ) : step === 'folder' ? (
            <div className="fr-form">
              <h1>Where should AttendWell keep registers?</h1>
              <p>Each workshop is one folder here: its details, its register and a note of where its name list came from. Past sessions stay here, so you can open them later.</p>
              <div className="field"><span className="lab">Registers folder</span>
                <div className="fr-folder">
                  <div className="path mono" aria-label="Registers folder"><Icon name="folder" />{folder}</div>
                  <button type="button" className="btn" onClick={() => void choose()}><Icon name="folder-open" />Choose folder…</button>
                </div>
              </div>
              <div className="callout"><Icon name="shield-check" size={18} /><span>This folder is on this laptop and is never uploaded. If you choose a synced folder (iCloud Drive, OneDrive), the register is copied wherever that service copies files.</span></div>
            </div>
          ) : (
            <div className="fr-form">
              <h1>Create your first workshop</h1>
              <p>You can add the name list in the next step, by pasting names or importing a spreadsheet.</p>
              <WorkshopFields state={form} folderPath={folder.startsWith('~') ? folder.replace('~', home) : folder} home={home} />
            </div>
          )}
          {error ? <p className="fr-error" role="alert">{error}</p> : null}
        </div>
        <div className="fr-foot">
          {step === 'welcome' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void openExample()}><Icon name="book-open" />Open the example workshop instead</button>
          ) : <button type="button" className="btn" disabled={busy} onClick={() => setStep(step === 'workshop' ? 'folder' : 'welcome')}>Back</button>}
          {step === 'welcome' ? <button type="button" className="btn primary big" onClick={() => setStep('folder')}>Set up AttendWell<Icon name="arrow-right" /></button>
            : step === 'folder' ? <button type="button" className="btn primary big" disabled={busy} onClick={() => void toWorkshop()}>Continue<Icon name="arrow-right" /></button>
              : <button type="button" className="btn primary big" disabled={busy} onClick={() => void create()}>Create workshop<Icon name="arrow-right" /></button>}
        </div>
      </div>
    </div>
  );
}
