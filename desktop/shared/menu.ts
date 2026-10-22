// The menu bar, generated from the registry (App Patterns buildMenuTemplate) and arranged to the locked design:
// macOS: AttendWell, File, Edit, View, Session, Window, Help. Windows: the AttendWell menu's items move to File
// (Settings…, Export/Import Settings…, Exit) and Help (Check for Updates…, About). Pure: Electron builds the real menu from this template.
import { buildMenuTemplate, toAccelerator, type MenuItem } from '@app-patterns/commands';
import { MENU_DECLS, MENU_ORDER, registry, type CommandCtx } from './commands.ts';

export interface MenuOptions {
  platform: 'mac' | 'win';
  bindings: Record<string, string>;
  ctx: CommandCtx;
  run(id: string): void;
  appName?: string;
}

const SEP: MenuItem = { type: 'separator' };

function itemFor(id: string, o: MenuOptions, label?: string, accelerator?: string): MenuItem {
  const def = registry.byId(id)!;
  let off = false;
  try { off = def.available !== undefined && def.available(o.ctx) !== null; } catch { off = true; }
  const chord = Object.hasOwn(o.bindings, id) ? o.bindings[id] ?? '' : '';
  let accel = accelerator ?? toAccelerator(chord);
  if (accel && o.platform === 'win') accel = accel.replace(/\bCmd\b/g, 'Ctrl');
  return { label: label ?? def.label, ...(accel ? { accelerator: accel, registerAccelerator: false } : {}), ...(off ? { enabled: false } : {}), click: () => o.run(id) };
}

const isSep = (i: MenuItem): boolean => i.type === 'separator';
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const i of items) {
    if (isSep(i) && (out.length === 0 || isSep(out[out.length - 1]!))) continue;
    out.push(i);
  }
  while (out.length && isSep(out[out.length - 1]!)) out.pop();
  return out;
}

/** Windows shows Ctrl where the registry's chords say ⌘. */
function toCtrl(m: MenuItem): MenuItem {
  return {
    ...m,
    ...(m.accelerator ? { accelerator: m.accelerator.replace(/\bCmd\b/g, 'Ctrl') } : {}),
    ...(m.submenu ? { submenu: m.submenu.map(toCtrl) } : {}),
  };
}

export function buildAppMenu(o: MenuOptions): MenuItem[] {
  const appName = o.appName ?? 'AttendWell';
  const check = itemFor('app.check-for-updates', o);
  const about = itemFor('app.about', o);
  const mac = buildMenuTemplate({
    appName, registry, menus: MENU_DECLS, bindings: o.bindings, run: o.run, ctx: o.ctx,
    appItems: { app: [check] },
  });
  const named = new Map<string, MenuItem>(mac.map((m) => [m.label ?? '', m]));
  const appMenu = named.get(appName)!;
  const sub = appMenu.submenu ?? [];

  if (o.platform === 'mac') {
    // The package opens the App menu with the system About role, and closes it with the Quit role; the Window menu has the Close role.
    // Each is swapped for the registry's own item, so the chord shown is the effective one.
    const swap = (items: MenuItem[]): MenuItem[] => items.map((i) =>
      i.role === 'about' ? about
        : i.role === 'quit' ? itemFor('app.quit', o)
          : i.role === 'close' ? itemFor('window.close', o)
            : i);
    const out = mac.map((m) => (m.submenu ? { ...m, submenu: tidy(swap(m.submenu)) } : m));
    return MENU_ORDER.map((label) => out.find((m) => m.label === (label === 'AttendWell' ? appName : label))).filter((m): m is MenuItem => m !== undefined);
  }

  // Windows: no App menu.
  const settingsItems = sub.filter((i) => i.label === registry.byId('settings')!.label || i.label === registry.byId('export-settings')!.label || i.label === registry.byId('import-settings')!.label);
  const exit = itemFor('app.quit', o, 'Exit', 'Alt+F4');
  const file = named.get('File')!;
  const help = named.get('Help')!;
  const windowMenu = named.get('Window')!;
  const fileItems = tidy([...(file.submenu ?? []), SEP, ...settingsItems, SEP, exit]);
  const helpItems = tidy([...(help.submenu ?? []), SEP, check, about]);
  const closeSwap = (items: MenuItem[]): MenuItem[] => items.map((i) => (i.role === 'close' ? itemFor('window.close', o) : i));
  const order = ['File', 'Edit', 'View', 'Session', 'Window', 'Help'];
  const pick = (label: string): MenuItem | undefined => {
    if (label === 'File') return { ...file, submenu: fileItems };
    if (label === 'Help') return { ...help, submenu: helpItems };
    if (label === 'Window') return { ...windowMenu, submenu: tidy(closeSwap(windowMenu.submenu ?? [])) };
    return named.get(label);
  };
  return order.map(pick).filter((m): m is MenuItem => m !== undefined).map(toCtrl);
}

/** Every label in a template, depth first (for the consistency tests). */
export function menuLabels(template: MenuItem[]): string[] {
  return template.flatMap((m) => [m.label ?? '', ...(m.submenu ? menuLabels(m.submenu) : [])]).filter(Boolean);
}
