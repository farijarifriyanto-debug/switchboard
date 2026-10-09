import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema,ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function makeExtendedServer(options={}) {
  const full=!options.toolsOnly
  const server=new Server({name:'extended',version:'1.0.0'},{capabilities:{tools:{listChanged:true},...(full?{resources:{listChanged:true},prompts:{listChanged:true}}:{})}})
  const state=options.state??{changed:false}
  const defs=['structured','mixed','failing','change','slow',...(options.collision?['list_resources']:[])].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))
  server.setRequestHandler(ListToolsRequestSchema,async req=>req.params?.cursor?{tools:defs.slice(3)}:{tools:defs.slice(0,3),nextCursor:'page2'})
  server.setRequestHandler(CallToolRequestSchema,async req=>{
    if(req.params.name==='change'){state.changed=true; if(full)await server.sendResourceListChanged();return{content:[{type:'text',text:'changed'}]}}
    if(req.params.name==='slow')await new Promise(r=>setTimeout(r,1000))
    if(req.params.name==='failing')return{content:[],structuredContent:{reason:'structured failure'},isError:true}
    return{content:req.params.name==='mixed'?[{type:'text',text:'human answer'}]:[],structuredContent:{value:42}}
  })
  if(full){
    server.setRequestHandler(ListResourcesRequestSchema,async req=>req.params?.cursor?{resources:[{name:state.changed?'updated':'second',uri:'memo://second'}]}:{resources:[{name:'first',uri:'memo://first'}],nextCursor:'next'})
    server.setRequestHandler(ListResourceTemplatesRequestSchema,async()=>({resourceTemplates:[{name:'note',uriTemplate:'memo://{id}'}]}))
    server.setRequestHandler(ReadResourceRequestSchema,async req=>({contents:req.params.uri==='memo://binary'?[{uri:req.params.uri,mimeType:'image/png',blob:'AAA='}]:[{uri:req.params.uri,mimeType:'text/plain',text:'resource text'}]}))
    server.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:[{name:'review',arguments:[{name:'topic',required:true}]}]}))
    server.setRequestHandler(GetPromptRequestSchema,async req=>({messages:[{role:'user',content:{type:'text',text:`Review ${req.params.arguments?.topic}`}}]}))
  }
  return server
}
if(process.argv[1]===new URL(import.meta.url).pathname){await makeExtendedServer({toolsOnly:process.argv.includes('--tools-only'),collision:process.argv.includes('--collision')}).connect(new StdioServerTransport())}
