// Disposable smart-HTTP Git transport, backed by git's actual CGI backend.
// No application interception, mocks or fault injection.
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
const execPath=execFileSync('git',['--exec-path'],{encoding:'utf8'}).trim();
http.createServer((req,res)=>{
 if(req.url==='/health'){res.end('ok');return;}
 const url=new URL(req.url,'http://git-remote');
 const child=spawn(execPath+'/git-http-backend',[],{env:{...process.env,GIT_PROJECT_ROOT:'/repos',GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:req.headers['content-length']??'',HTTP_CONTENT_ENCODING:req.headers['content-encoding']??''}});
 req.pipe(child.stdin);child.stdin.on('error',()=>{});
 let pending=Buffer.alloc(0),sent=false;
 child.stdout.on('data',chunk=>{
  if(sent){res.write(chunk);return;}
  pending=Buffer.concat([pending,chunk]);const split=pending.indexOf('\r\n\r\n');if(split<0)return;
  let status=200;
  for(const line of pending.subarray(0,split).toString().split('\r\n')){const colon=line.indexOf(':');if(colon<0)continue;const key=line.slice(0,colon),value=line.slice(colon+1).trim();if(key.toLowerCase()==='status')status=parseInt(value,10);else res.setHeader(key,value);}
  res.writeHead(status);sent=true;res.write(pending.subarray(split+4));
 });
 child.stderr.on('data',d=>console.error(d.toString()));
 child.on('error',e=>{console.error(e.message);if(!res.headersSent)res.writeHead(500);sent=true;res.end();});
 child.on('close',()=>{if(!res.headersSent)res.writeHead(500);res.end();});
}).listen(8080,'0.0.0.0',()=>console.log('Disposable synthetic Git HTTP remote ready'));
