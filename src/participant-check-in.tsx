import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Check,Search,Users,UserRound,ChevronRight,X,CloudOff,Clock,AlertTriangle} from 'lucide-react';
import {participantSync,type Entry} from './offline-participant';
import {formatWorkshopDate,clockTime} from './workshop-format';
const recovery='If the check-in link has changed, check-ins saved on this device stay with the previous link: reopen the previous link on this device to show them.';
export function ParticipantCheckIn({base=''}:{base?:string}){
 const sync=useMemo(()=>participantSync(localStorage,undefined,undefined,undefined,base),[base]);
 const [entries,setEntries]=useState<Entry[]>(()=>sync.entries()),[term,setTerm]=useState(''),[choice,setChoice]=useState<Entry|null>(null),[saved,setSaved]=useState<{token:string;name:string}|null>(null);
 const [link,setLink]=useState(()=>sync.link()),[closed,setClosed]=useState(()=>sync.closed()),[handover,setHandover]=useState(false),[failed,setFailed]=useState<string|null>(null);
 const title=useRef<HTMLHeadingElement>(null),confirmButton=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null),reading=useRef(false);
 const snapshot=sync.snapshot(),queued=sync.queue(),help=sync.organiserHelp();
 function redraw(){setEntries(sync.entries());setClosed(sync.closed());setLink(sync.link())}
 // Names polling and delivery run independently: a slow send never delays closure or undo, and a slow poll never delays sending.
 async function poll(){
  if(reading.current)return;reading.current=true;
  try{await sync.refresh()}finally{reading.current=false;redraw()}
 }
 function load(){void poll();void sync.flush()}
 // Background delivery reports through device storage; every change redraws, so statuses follow what actually happened.
 useEffect(()=>sync.subscribe(redraw),[sync]);
 useEffect(()=>{
  // The offline shell worker is registered only here, on the names-only participant path; its scope is that path's prefix.
  if('serviceWorker' in navigator)navigator.serviceWorker.register(base+'/sw.js',{scope:base+'/'}).catch(()=>undefined);
  // Polling continues while closed, so a reopened window is picked up and queued check-ins are retried.
  load();const timer=setInterval(load,5000);const visible=()=>{if(document.visibilityState==='visible')load()};const online=load;
  document.addEventListener('visibilitychange',visible);window.addEventListener('online',online);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',online)}
 },[]);
 useEffect(()=>{if(!snapshot||closed)return;const timer=setTimeout(redraw,Math.max(0,snapshot.closesAt-Date.now()));return()=>clearTimeout(timer)},[snapshot?.closesAt,closed]);
 useEffect(()=>{if(closed)setChoice(null)},[closed]);
 function reset(){setChoice(null);setSaved(null);setTerm('');requestAnimationFrame(()=>title.current?.focus())}
 useEffect(()=>{if(!saved)return;const timer=setTimeout(()=>setSaved(null),5000);return()=>clearTimeout(timer)},[saved]);
 useEffect(()=>{if(!choice)return;const prior=document.activeElement as HTMLElement;confirmButton.current?.focus();function key(e:KeyboardEvent){if(e.key==='Escape'){setChoice(null);return}if(e.key==='Tab'){const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);if(prior.isConnected)prior.focus();else title.current?.focus()}},[choice]);
 // Saved on this device before anything is sent: the acknowledgement never waits for the network.
 function confirm(){
  const person=snapshot?.names.find(n=>n.token===choice?.token);if(!choice||!person||closed)return;
  const ack=sync.enqueue(person);redraw();setChoice(null);
  if(ack.kind==='queued'){setFailed(null);setSaved({token:ack.token,name:ack.name});setTerm('');}
  // Storage refused the write: nothing was queued or sent, so say so instead of acknowledging.
  else if(ack.kind==='failed'){setSaved(null);setFailed(`Not saved, ${ack.name}. ${ack.message}`);}
 }
 const fold=(s:string)=>s.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const words=fold(term).split(/\s+/).filter(Boolean);
 const matches=entries.filter(p=>words.every(w=>fold(p.name).includes(w)));
 const pending=matches.filter(p=>p.status==='pending'),checked=matches.filter(p=>p.status!=='pending');
 const waiting=queued.filter(o=>o.state==='pending').length,unsent=queued.filter(o=>o.state==='unsent');
 // Both come from finished requests: the list poll failed, or the last send did not reach the register while records wait.
 const offline=link.names==='offline',failing=waiting>0&&link.delivery==='failing';
 const savedAt=snapshot?clockTime(snapshot.savedAt):'';
 const label:Record<Entry['status'],string>={pending:'',"checked-in":'Checked in',queued:'Saved on this device · waiting to sync',held:'Held for an organiser to check',unsent:'Not sent · please tell an organiser'};
 // The acknowledgement banner follows the live status of the person just saved.
 const savedStatus=saved?entries.find(e=>e.token===saved.token)?.status??'queued':null;
 const savedTone=savedStatus==='checked-in'?'saved':savedStatus==='queued'?'queued':'attention';
 const workshop=snapshot?.workshop;
 // Readability layout: heading first, sticky search with a compact sync chip, names, then secondary details in the footer.
 return <main className="participant">
 {closed?<section className="card participant-step"><h1 ref={title} tabIndex={-1}>Check-in has closed</h1><p>{help}</p><p className="participant-help" role="status">If check-in reopens, this page returns to the name list automatically.</p>
  {queued.length>0&&<div className="participant-handover" role="alert"><h2><AlertTriangle size={20}/>{queued.length} {queued.length===1?'check-in was':'check-ins were'} saved on this device but not sent</h2><p>Online check-in closed before these reached the register. They are sent automatically if check-in reopens; otherwise please show this list to an organiser so they can record them.</p><ul>{queued.map(o=><li key={o.opId}><strong>{o.name}</strong> · saved {clockTime(o.queuedAt)}{o.message?` · ${o.message}`:''}</li>)}</ul>
   {handover?<div className="actions"><button className="primary" onClick={()=>{sync.handedOver();setHandover(false);redraw()}}>Yes, the organiser has recorded them</button><button onClick={()=>setHandover(false)}>Cancel</button></div>:<button onClick={()=>setHandover(true)}>Organiser: mark as handed over</button>}</div>}
  <p className="participant-help">{recovery}</p></section>
 :offline&&!snapshot?<section className="card participant-step"><h1 ref={title} tabIndex={-1}>Check-in list unavailable</h1><p role="alert">The connection is interrupted and this device has no saved copy of the list yet, so it cannot check anyone in offline.</p><p>Check the connection and try again. {help}</p><button className="primary" onClick={load}>Try again</button><p className="participant-help">{recovery}</p></section>
 :<section className="participant-step participant-main"><h1 ref={title} tabIndex={-1} className="participant-welcome"><Users className="participant-welcome-icon"/><span>Please</span>{' '}<span>check in</span></h1>
 <div className="participant-bar"><label className="search"><Search size={26}/><input aria-label="Find your name" placeholder="Type your name" autoComplete="off" value={term} onChange={e=>setTerm(e.target.value)}/>{term&&<button className="search-clear" onClick={()=>setTerm('')} aria-label="Clear search"><X size={22}/></button>}</label>
 <div className={'participant-sync '+(offline||failing?'offline':waiting?'sending':'')} role="status" aria-live="polite">{offline?<><CloudOff size={18}/><span>Offline. {waiting?<><strong>{waiting}</strong> saved on this device, not yet sent</>:'Check-ins save on this device'} · names as of {savedAt}</span></>:failing?<><CloudOff size={18}/><span>Not reaching the register. <strong>{waiting}</strong> saved on this device, not yet sent · retrying</span></>:waiting?<><Clock size={18}/><span>Sending <strong>{waiting}</strong> saved on this device…</span></>:link.names==='online'?<><Check size={18}/><span>Online · check-ins go to the register</span></>:<span>Connecting…</span>}</div></div>
 {failed&&<div className="alert" role="alert">{failed}</div>}
 {unsent.length>0&&<div className="alert" role="alert">{unsent.length} saved {unsent.length===1?'check-in':'check-ins'} could not be sent. Please tell an organiser.</div>}
 {saved&&<div className={'participant-saved '+savedTone} role="status">{savedStatus==='checked-in'?<Check size={30}/>:savedStatus==='queued'?<Clock size={30}/>:<AlertTriangle size={30}/>}<div>{savedStatus==='checked-in'?<><strong>You’re checked in, {saved.name}</strong><p>Thank you. You can take your seat.</p></>
  :savedStatus==='queued'?<><strong>Saved on this device, {saved.name}</strong><p>{offline||failing?'Not yet sent to the register; it will be sent automatically when the connection returns.':'Sending to the register…'} You can take your seat.</p></>
  :savedStatus==='held'?<><strong>Saved, {saved.name} · an organiser will check it</strong><p>{help}</p></>
  :<><strong>Not sent, {saved.name}</strong><p>{entries.find(e=>e.token===saved.token)?.message??''} {help}</p></>}</div><button onClick={reset}>Next person</button></div>}
 {link.names==='unknown'&&!snapshot?<p role="status">Loading names…</p>:<>
 <section className="participant-section" aria-label="Not checked in"><h2>Tap your name <span>{pending.length}</span></h2><ul className="participant-list">{pending.map(p=><li key={p.token}><button onClick={()=>setChoice(p)}><span className="person-icon"><UserRound size={30}/></span><span className="list-person-name">{p.name}</span><ChevronRight size={30}/></button></li>)}</ul>{!pending.length&&<p className="participant-empty">{term?'No pending name matches your search.':'Everyone on this list is checked in.'}</p>}</section>
 <section className="participant-section checked-section" aria-label="Checked in"><h2><Check size={19}/>Checked in <span>{checked.length}</span></h2><ul className="participant-list">{checked.map(p=><li key={p.token} className={'checked-person '+(p.status!=='checked-in'?'local-only ':'')+(saved?.token===p.token?'just-checked':'')}><span className="person-icon"><UserRound size={26}/></span><span className="list-person-name">{p.name}{p.status!=='checked-in'&&<small className="sync-label">{label[p.status]}</small>}</span>{p.status==='checked-in'?<Check size={22}/>:<Clock size={22}/>}{p.status==='checked-in'&&<span className="sr-only">{label[p.status]}</span>}</li>)}</ul>{!checked.length&&<p className="participant-empty">{term?'No checked-in name matches your search.':'No one has checked in yet.'}</p>}</section>
 {!matches.length&&<p className="participant-nomatch">No matching name. {help}</p>}
 </>}
 <p className="participant-help">Can’t find your name, or checked in by mistake? {help}</p></section>}
 {choice&&!closed&&<div className="overlay"><section ref={panel} className="panel participant-confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-name-title"><div className="panel-title"><h2 id="confirm-name-title">Is this you?</h2><button onClick={()=>setChoice(null)} aria-label="Close confirmation"><X/></button></div><div className="confirmation-person"><span className="person-icon"><UserRound size={32}/></span><p className="selected-name">{choice.name}</p></div><p>Confirm your name to record your attendance.</p><div className="actions"><button ref={confirmButton} className="primary" onClick={confirm}>That’s me — check in</button><button onClick={()=>setChoice(null)}>Go back</button></div></section></div>}
 <footer className="participant-footer">{snapshot?.demo&&<span className="participant-demo">Fictional preview · example names only</span>}{workshop&&<span>{formatWorkshopDate(workshop.date,false)} · {workshop.title}</span>}<span>Only names and check-in status are shown or saved on this device. Your email address stays with the organisers.</span></footer></main>
}
