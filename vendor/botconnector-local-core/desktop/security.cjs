const path=require('node:path');
const {pathToFileURL}=require('node:url');

const EXTERNAL_HOSTS=new Set(['github.com','huggingface.co','lmstudio.ai']);
const APP_FILE=path.join(__dirname,'index.html');

function appUrl(){return pathToFileURL(APP_FILE).href;}
function isSafeExternal(raw){try{const url=new URL(String(raw));return url.protocol==='https:'&&EXTERNAL_HOSTS.has(url.hostname.toLowerCase());}catch{return false;}}
function isTrustedNavigation(raw){return String(raw)===appUrl();}
function isTrustedSender(event,webContents){return Boolean(event?.sender&&event.sender===webContents&&event.senderFrame?.url===appUrl());}
function providerName(value){const provider=String(value||'').toLowerCase();if(!['nebius','together'].includes(provider))throw new Error('Unknown cloud provider');return provider;}
function plainObject(value){return Boolean(value&&typeof value==='object'&&!Array.isArray(value));}

module.exports={APP_FILE,EXTERNAL_HOSTS,appUrl,isSafeExternal,isTrustedNavigation,isTrustedSender,providerName,plainObject};
