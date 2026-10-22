// The Get started page (gs-page): six task chapters with the keys that do them, "N of 6 tried", How AttendWell works, and the
// link that hides the button. A chapter is tried when its command has run.
import { CHAPTERS, HOW_IT_WORKS, triedChapters } from '../../shared/get-started.ts';
import { Icon } from './icons.tsx';
import { Keys } from './Keys.tsx';

export function GetStarted({ ran, bindings, platform, exampleOffered, onOpenExample, onHide, onLibrary, hidden }: {
  ran: string[]; bindings: Record<string, string>; platform: 'mac' | 'win'; exampleOffered: boolean; hidden: boolean;
  onOpenExample(): void; onHide(): void; onLibrary(): void;
}): JSX.Element {
  const tried = triedChapters(ran);
  return (
    <>
      <div className="toolbar">
        <button type="button" className="btn icon" onClick={onLibrary} aria-label="Show all workshops" title="Show all workshops"><Icon name="library" size={18} /></button>
        <div className="wt"><b>Get started</b><small>Example workshop · fictional names</small></div>
      </div>
      <div className="main">
        <section className="panel" aria-label="Things to try">
          <div className="panel-head"><span>Things to try in the example workshop</span><span className="count-chip">{tried.length} of {CHAPTERS.length} tried</span></div>
          <div className="scroll">
            {CHAPTERS.map((c, i) => (
              <div className="gs-item" key={c.id}>
                <span className={`tick ${tried.includes(c.id) ? 'done' : ''}`}>{tried.includes(c.id) ? <Icon name="check" size={15} /> : i + 1}</span>
                <span className="grow"><b>{c.title}</b><small>{c.text}</small></span>
                {c.id === 'open' ? <button type="button" className="btn" onClick={onOpenExample}>{exampleOffered ? 'Open' : 'Open the example'}</button> : c.command ? <Keys chord={bindings[c.command] ?? ''} platform={platform} /> : null}
              </div>
            ))}
          </div>
          <div className="gs-foot">
            <span>Every command is in the palette <Keys chord={bindings['app.palette'] ?? ''} platform={platform} /> and the shortcuts are listed with <Keys chord={bindings['cheat'] ?? ''} platform={platform} />.</span>
            {hidden ? <span /> : <button type="button" className="link" onClick={onHide}>Hide the Get started button</button>}
          </div>
        </section>
        <aside className="panel" aria-label="How AttendWell works">
          <div className="panel-head">How AttendWell works</div>
          <div className="scroll how">
            {HOW_IT_WORKS.map((h) => (
              <p key={h.lead}><Icon name={h.icon === 'tablet' ? 'tablet' : h.icon} size={18} /><span><b>{h.lead}</b> {h.text}</span></p>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
