// Driving a real OpenClaw gateway and an installed host agent on a systemd target, for the suites
// that install one: what an operator does with `openclaw` on the host, and what the gateway's
// MCP bridge does with the host agent, minus a model.

import type { VmTarget } from './vm-container.js'

export async function gatewayReady(vm: VmTarget): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const probe = await vm.inspect('curl -s --max-time 3 http://127.0.0.1:18789/startupz; docker exec openclaw true && echo EXEC-OK')
    if (/"status"\s*:\s*"started"/.test(probe.stdout) && probe.stdout.includes('EXEC-OK')) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('the gateway did not come back')
}

/**
 * Some keys make the gateway restart itself, and the `docker exec` that set one is killed with
 * it (137). The write landed before the restart, so wait for the gateway and carry on; the
 * assertions that matter read the configuration back.
 */
export async function oc(vm: VmTarget, args: string): Promise<{ stdout: string; exitCode: number }> {
  const r = await vm.inspect(`docker exec openclaw openclaw ${args}`)
  if (r.exitCode === 137) {
    await gatewayReady(vm)
    return { stdout: r.stdout, exitCode: 0 }
  }
  if (/config set/.test(args)) await gatewayReady(vm)
  return r
}

export async function gatewayConfig(vm: VmTarget): Promise<Record<string, unknown>> {
  return JSON.parse((await vm.inspect('cat /var/lib/clawops/openclaw/openclaw.json')).stdout) as Record<string, unknown>
}

/** Set a key and read the file back until it holds the value: a restart can lose a write. */
export async function setConfig(vm: VmTarget, key: string, value: unknown): Promise<void> {
  let held: unknown
  for (let i = 0; i < 5; i++) {
    await oc(vm, `config set ${key} '${JSON.stringify(value)}' --strict-json`)
    const cfg = await gatewayConfig(vm)
    held = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cfg)
    if (JSON.stringify(held) === JSON.stringify(value)) return
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`${key} did not keep ${JSON.stringify(value)}; the file holds ${JSON.stringify(held)}`)
}

/**
 * An operator-only agent "ops", configured the way the docs tell an operator to. Each key is read
 * back: the channel write restarts the gateway, and a write in that window is lost. `strict` also
 * takes command and file tools from the main agent, as `agent install --strict` requires.
 */
export async function configureOperatorAgent(vm: VmTarget, opts: { strict?: boolean } = {}): Promise<void> {
  const add = await oc(vm, 'agents add ops --non-interactive --workspace /home/node/.openclaw/workspace-ops')
  if (add.exitCode !== 0) throw new Error(`agents add ops: ${add.stdout}`)
  await setConfig(vm, 'bindings', [{ agentId: 'ops', match: { channel: 'telegram', peer: { kind: 'direct', id: '12345' } } }])
  await setConfig(vm, 'channels.telegram', { enabled: false, dmPolicy: 'pairing' })
  await setConfig(vm, 'tools.agentToAgent.enabled', false)
  await setConfig(vm, 'tools.sessions.visibility', 'agent')
  if (opts.strict) await setConfig(vm, 'agents.entries.main.tools.profile', 'messaging')
}

export interface ToolCall { name: string; arguments?: Record<string, unknown> }
export interface ToolAnswer { name: string; isError: boolean; text: string }

/** The MCP client, run on the host with the host agent's own Node. Prints one JSON line per call. */
function hostAgentClient(calls: ToolCall[]): string {
  return `
const env=require('fs').readFileSync('/etc/clawops-agent/agent.env','utf8');
const token=/CLAWOPS_MCP_TOKEN=(\\S+)/.exec(env)[1];
const cfg=JSON.parse(require('fs').readFileSync('/etc/clawops-agent/agent.json','utf8'));
const url='http://'+cfg.listen.address+':'+cfg.listen.port+'/';
let sid;
async function rpc(method,params,id){
  const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token};
  if(sid)h['mcp-session-id']=sid;
  const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(id===undefined?{jsonrpc:'2.0',method,params}:{jsonrpc:'2.0',id,method,params})});
  sid=r.headers.get('mcp-session-id')||sid;
  const t=await r.text();
  const line=t.split('\\n').find(l=>l.startsWith('data: '));
  return line?JSON.parse(line.slice(6)):(t?JSON.parse(t):null);
}
(async()=>{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}},1);
  await rpc('notifications/initialized',{});
  let id=2;
  for(const c of ${JSON.stringify(calls)}){
    const r=await rpc('tools/call',{name:c.name,arguments:c.arguments||{}},id++);
    console.log(JSON.stringify({name:c.name,isError:!!r.result?.isError,text:(r.result?.content||[]).map(x=>x.text).join('\\n')}));
  }
})().catch(e=>{console.error(e);process.exit(1)});`
}

/** Call the installed host agent through its own listener, as the gateway does. */
export async function callHostAgent(vm: VmTarget, calls: ToolCall[]): Promise<ToolAnswer[]> {
  // Base64 into a file, so no shell quoting stands between the script and Node.
  const b64 = Buffer.from(hostAgentClient(calls)).toString('base64')
  const r = await vm.inspect(`echo ${b64} | base64 -d > /root/mcpcall.js && /opt/clawops-agent/node/bin/node /root/mcpcall.js`)
  if (r.exitCode !== 0) throw new Error(`the MCP client failed: ${r.stdout}`)
  return r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as ToolAnswer)
}
