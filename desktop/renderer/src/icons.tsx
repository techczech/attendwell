// The lucide icons the registry names (by their kebab-case names) and the interface uses. One place, so the bundle holds only these.
import {
  ArrowDownUp, ArrowRight, Ban, BookOpen, Calendar, CalendarDays, Check, ChevronDown, ChevronUp, CircleAlert, CircleCheck, ClipboardPaste, Command, Copy,
  Download, FileDown, FileInput, FileUp, Folder, FolderOpen, Globe, Info, Keyboard, Laptop, Library, LogOut, Mail, Pencil, Play, PlugZap, Plus, Power,
  Printer, QrCode, RefreshCw, RotateCcw, RotateCw, ScanLine, Search, Settings, ShieldCheck, Sparkles, Tablet, Undo2, Upload, UserCheck, UserPlus, UserRound,
  UserX, Users, Wifi, WifiOff, X, Zap, Ellipsis, Hourglass, Lock, Timer, CircleX, Smartphone, type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  'arrow-down-up': ArrowDownUp, 'arrow-right': ArrowRight, ban: Ban, 'book-open': BookOpen, calendar: Calendar, 'calendar-days': CalendarDays, check: Check,
  'chevron-down': ChevronDown, 'chevron-up': ChevronUp, 'circle-alert': CircleAlert, 'circle-check': CircleCheck, 'clipboard-paste': ClipboardPaste,
  command: Command, copy: Copy, download: Download, 'file-down': FileDown, 'file-input': FileInput, 'file-up': FileUp, folder: Folder, 'folder-open': FolderOpen,
  globe: Globe, info: Info, keyboard: Keyboard, laptop: Laptop, library: Library, 'log-out': LogOut, mail: Mail, pencil: Pencil, play: Play, 'plug-zap': PlugZap,
  plus: Plus, power: Power, printer: Printer, 'qr-code': QrCode, 'refresh-cw': RefreshCw, 'rotate-ccw': RotateCcw, 'rotate-cw': RotateCw, 'scan-line': ScanLine,
  search: Search, settings: Settings, 'shield-check': ShieldCheck, sparkles: Sparkles, tablet: Tablet, 'undo-2': Undo2, upload: Upload, 'user-check': UserCheck,
  'user-plus': UserPlus, 'user-round': UserRound, 'user-x': UserX, users: Users, wifi: Wifi, 'wifi-off': WifiOff, x: X, zap: Zap, ellipsis: Ellipsis, hourglass: Hourglass, lock: Lock, timer: Timer, 'circle-x': CircleX, smartphone: Smartphone,
};

export function Icon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const C = ICONS[name] ?? Command;
  return <C size={size} strokeWidth={1.9} aria-hidden="true" className="ic" />;
}

export const ICON_NAMES: readonly string[] = Object.keys(ICONS);
