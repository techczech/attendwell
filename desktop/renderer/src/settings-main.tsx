// The Settings window's page: the shared @app-patterns/settings-react window over this app's schema and command registry, with the
// app's own Connection page and the update card in About. State and every action come from the main process through the preload.
import '@app-patterns/settings-react/settings.css';
import './settings-page.css';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsWindow, type CustomPage, type SheetState } from '@app-patterns/settings-react';
import { SettingsUpdatesCard } from '@app-patterns/settings-react/updates';
import type { SectionRequest, SettingsBridge, SettingsView } from '@app-patterns/settings-electron';
import type { UpdateSnapshot } from '@app-patterns/updates';
import { MENU_DECLS, registry } from '../../shared/commands.ts';
import type { UpdatesApi } from '../../shared/ipc.ts';
import { ROW_HINTS, schema } from '../../shared/settings-schema.ts';
import { ConnectionPage } from './ConnectionPage.tsx';
import { updateActionsFor } from './updateActions.ts';

declare global { interface Window { attendwellUpdates: UpdatesApi; bridleSettings: SettingsBridge } }

type Opened = { section: string; sheet?: SheetState; n: number };

function SettingsApp(): JSX.Element | null {
  const bridge = window.bridleSettings;
  const updatesApi = window.attendwellUpdates;
  const [view, setView] = useState<SettingsView | null>(null);
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 });
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null);

  useEffect(() => {
    const open = async (req: SectionRequest): Promise<void> => {
      let sheet: SheetState | undefined;
      if (req.action === 'import') {
        const picked = await Promise.resolve(bridge.importPick()).catch(() => null);
        if (picked) sheet = { kind: picked.preview.refused ? 'refused' : 'import', fileName: picked.fileName, preview: picked.preview };
      }
      setOpened((o) => ({ section: req.section, ...(sheet ? { sheet } : {}), n: o.n + 1 }));
    };
    void bridge.view().then((v) => { setView(v); if (v.request) void open(v.request); });
    void updatesApi.snapshot().then(setUpdate);
    const offChanged = bridge.onChanged(setView);
    const offSection = bridge.onSection((r) => void open(r));
    const offUpdate = updatesApi.onChanged(setUpdate);
    return () => { offChanged(); offSection(); offUpdate(); };
  }, []);

  const actions = useMemo(() => updateActionsFor((a) => updatesApi.action(a), (v) => updatesApi.loadNotes(v), (version) => { void updatesApi.showNotes(version); }), []);
  if (!view || !update) return null;
  const customPages: CustomPage[] = [{ id: 'connection', label: 'Connection', icon: 'globe', render: () => <ConnectionPage /> }];
  return (
    <div style={{ display: 'contents' }}>
      <div className="aw-settings-titlebar">Settings</div>
      <SettingsWindow
        key={opened.n}
        className="aw-settings"
        schema={schema}
        state={view.state}
        registry={registry}
        menus={MENU_DECLS}
        appInfo={view.appInfo}
        actions={bridge}
        slots={view.slots}
        rowHints={ROW_HINTS}
        customPages={customPages}
        updateCard={<SettingsUpdatesCard snapshot={update} actions={actions} />}
        changesSeenAt={seenAt}
        onChangesSeen={setSeenAt}
        initial={{ section: opened.section, ...(opened.sheet ? { sheet: opened.sheet } : {}) }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><SettingsApp /></StrictMode>);
