import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {createScope} from '@deepseek-ai/dsh-scope';
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import {createDshAdapter} from '../../../src/sessions/dsh-adapter.ts';

test('bridge setup uses real scoped SDK tools for create and resume, never ordinary sessions or the host',async()=>{
 const root=new Context(),owned=new Map<string,{agent:any;scope:ReturnType<typeof createScope>}>();
 const mounts:string[]=[];
 const mint=async(id:string,setup:(ctx:Context)=>Promise<void>)=>{
  const agent:any={id,status:'idle',session:{id,header:{id,cwd:process.cwd()}},followup(){},whenIdle:async()=>{},cancel(){}};
  const scope=createScope(root,agent);agent.ctx=scope.ctx;await setup(scope.ctx);owned.set(id,{agent,scope});
  return {agent,dispose:async()=>{await scope.dispose();owned.delete(id);}};
 };
 root.provide('agents',{create:async(opts:any)=>mint(opts.sessionId,opts.setup),resume:async(opts:any)=>mint(opts.resumeSessionId,opts.setup),get:(id:string)=>owned.get(id)?.agent});
 await root.plugin(SystemPrompt);await root.plugin(ToolRuntime);
 const local={id:'desktop'};const localScope=createScope(root,local);
 const backend=createDshAdapter({ctx:root,sessionPrefix:'lark-link',setupAgent:(ctx,key)=>{
   mounts.push(key);
   for(const name of ['lark_send_local_file','lark_publish_site','lark_config_get'])ctx.get("tools")!.register(defineTool({name,description:'Feishu capability fixture',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>''}));
   ctx.get('systemPrompt')!.section({name:'lark-fixture',order:200,text:'Feishu-only prompt fixture'});
 }});
 try{
  const created=await backend.ensureAgent('dm:fixture');const agent=owned.get(created.sessionId)!.agent;
  assert.ok(root.get("tools")!.get('lark_send_local_file',agent));
  assert.equal(root.get("tools")!.get('lark_send_local_file',local),undefined);assert.deepEqual(root.get("tools")!.schemas(),[]);
  assert.ok((await root.get('systemPrompt')!.assemble({scope:agent})).sections.some(s=>s.name==='lark-fixture'));
  assert.ok(!(await root.get('systemPrompt')!.assemble({scope:local})).sections.some(s=>s.name==='lark-fixture'));
  await created.dispose();assert.equal(root.get("tools")!.get('lark_send_local_file',agent),undefined);
  const resumed=await backend.resumeAgent('dm:fixture','historical-fixture');const restored=owned.get(resumed.sessionId)!.agent;
  assert.ok(root.get("tools")!.get('lark_config_get',restored));assert.equal(root.get("tools")!.get('lark_publish_site',local),undefined);
  assert.deepEqual(mounts,['dm:fixture','dm:fixture']);await resumed.dispose();
 }finally{for(const {scope} of owned.values())await scope.dispose();await localScope.dispose();await root.fiber.dispose();}
});
