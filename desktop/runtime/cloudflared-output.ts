// Reads cloudflared's log lines (it logs to stderr) into the few facts the tunnel supervisor acts on.
// Pure functions; tested against recorded output in desktop/tests/fixtures/.

export type TunnelFailure='no-internet'|'blocked-by-network'|'cloudflared-missing'|'port-in-use'|'tunnel-refused'|'stopped-unexpectedly';

// What the organiser reads. Plain words, no jargon, no secrets.
export const FAILURE_TEXT:Record<TunnelFailure,string>={
 'no-internet':'No internet connection. Connect this computer to the internet and try again.',
 'blocked-by-network':'This network is blocking the connection to Cloudflare. Try another network, such as a phone hotspot.',
 'cloudflared-missing':'The tunnel program is missing from this copy of AttendWell. Reinstall AttendWell.',
 'port-in-use':'Another program is using the port AttendWell needs. Quit it, or restart the computer, and try again.',
 'tunnel-refused':'Cloudflare refused the tunnel. Wait a few minutes and try again.',
 'stopped-unexpectedly':'The tunnel kept stopping. Check the internet connection and try again.',
};

export type CloudflaredEvent=
 |{kind:'quick-url';url:string}
 |{kind:'connected';connIndex:number}
 |{kind:'disconnected';connIndex:number|null}
 |{kind:'problem';failure:TunnelFailure;fatal:boolean};

const QUICK_URL=/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?![\w.-])/;
const connIndex=(line:string)=>{const m=/connIndex=(\d+)/.exec(line);return m?Number(m[1]):null};

export function parseCloudflaredLine(line:string):CloudflaredEvent|null{
 const url=QUICK_URL.exec(line);
 // The URL appears in the banner box; never the API host api.trycloudflare.com.
 if(url&&url[1]!=='api')return {kind:'quick-url',url:`https://${url[1]}.trycloudflare.com`};
 if(/Registered tunnel connection/i.test(line)){const i=connIndex(line);return {kind:'connected',connIndex:i??0};}
 if(/status code 4\d\d.*quick Tunnel|failed to unmarshal quick Tunnel|Too Many Requests/i.test(line))return {kind:'problem',failure:'tunnel-refused',fatal:true};
 if(/failed to request quick Tunnel/i.test(line)){
  if(/no such host|network is unreachable|no route to host|server misbehaving|Temporary failure in name resolution|getaddrinfo|dial tcp: lookup/i.test(line))return {kind:'problem',failure:'no-internet',fatal:true};
  return {kind:'problem',failure:'blocked-by-network',fatal:true};
 }
 // Connectivity pre-checks (cloudflared 2026.x) are diagnostic only: a recorded run failed them and still connected.
 if(/precheck component="DNS Resolution".*status=fail/i.test(line))return {kind:'problem',failure:'no-internet',fatal:false};
 if(/precheck component="TCP Connectivity".*status=fail/i.test(line))return {kind:'problem',failure:'blocked-by-network',fatal:false};
 if(/precheck /i.test(line))return null;
 if(/lookup [\w.-]*argotunnel\.com.*(no such host|server misbehaving)|network is unreachable|no route to host/i.test(line))return {kind:'problem',failure:'no-internet',fatal:false};
 if(/Unable to establish connection with Cloudflare edge|failed to dial to edge|TLS handshake timeout|i\/o timeout|connection reset by peer|edge discovery: error looking up/i.test(line))return {kind:'problem',failure:'blocked-by-network',fatal:false};
 if(/Connection terminated|Unregistered tunnel connection|Serve tunnel error|Lost connection with the edge|Retrying connection in/i.test(line))return {kind:'disconnected',connIndex:connIndex(line)};
 return null;
}
