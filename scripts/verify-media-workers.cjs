// Candidate-only regression: WAV timing and original packaged worker startup.
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert');
const root=path.resolve(__dirname,'..'),result=process.env.WEFLOW_RESULT_ROOT;
if(!result)throw Error('WEFLOW_RESULT_ROOT required');
fs.mkdirSync(result,{recursive:true});
const esbuild=require('esbuild');
for(const name of ['imageDecryptWorker','transcribeWorker','pcmWav'])esbuild.buildSync({entryPoints:[path.join(root,'electron',name+'.ts')],bundle:true,platform:'node',format:'cjs',external:['sherpa-onnx-node'],outfile:path.join(result,name+'.js'),minify:true,logLevel:'warning'});
const {parsePcmWav}=require(path.join(result,'pcmWav.js'));
function wav(rate,extra=false){const pcm=Buffer.alloc(rate*2),fmt=Buffer.alloc(24);fmt.write('fmt ');fmt.writeUInt32LE(16,4);fmt.writeUInt16LE(1,8);fmt.writeUInt16LE(1,10);fmt.writeUInt32LE(rate,12);fmt.writeUInt32LE(rate*2,16);fmt.writeUInt16LE(2,20);fmt.writeUInt16LE(16,22);const data=Buffer.alloc(8);data.write('data');data.writeUInt32LE(pcm.length,4);const junk=extra?Buffer.from([74,85,78,75,1,0,0,0,0,0]):Buffer.alloc(0);const body=Buffer.concat([fmt,junk,data,pcm]),header=Buffer.alloc(12);header.write('RIFF');header.writeUInt32LE(body.length+4,4);header.write('WAVE',8);return Buffer.concat([header,body]);}
let checks=0;
for(const rate of [8000,16000,24000,48000])for(const extra of [false,true]){const r=parsePcmWav(wav(rate,extra));assert.equal(r.sampleRate,rate);assert.equal(r.samples.length,rate);checks++;}
for(const corrupt of [Buffer.alloc(44),wav(24000).subarray(0,45)]){assert.throws(()=>parsePcmWav(corrupt));checks++;}
const mismatch={originalOneSecondInterpretedAs:24000/16000,candidateOneSecondInterpretedAs:parsePcmWav(wav(24000)).samples.length/24000};
fs.writeFileSync(path.join(result,'wav-contract.json'),JSON.stringify({success:true,checks,...mismatch},null,2));
// Exercise the real compiled worker in a plain worker_threads environment.
// Loading ConfigService/electron-store here must fail this regression.
const {Worker}=require('node:worker_threads');
async function workerReply(addonPath){
 const worker=new Worker(path.join(result,'imageDecryptWorker.js'),{workerData:{imageNativeAddonPath:addonPath}});
 try{return await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Image worker did not reply')),5000);
  worker.once('error',error=>{clearTimeout(timer);reject(error);});
  worker.once('message',reply=>{clearTimeout(timer);resolve(reply);});
  worker.postMessage({id:31,datPath:'synthetic.dat',xorKey:0});
 });}finally{await worker.terminate();}
}
(async()=>{
 const addon=path.join(result,'synthetic-addon.cjs');
 try{
  fs.writeFileSync(addon,"module.exports={decryptDatNative:()=>({data:Buffer.from([1,2,3,4]),ext:'png',is_wxgf:true,rawSize:4})};");
  const valid=await workerReply(addon);assert.equal(valid.id,31);assert.equal(valid.ok,true);assert.deepEqual([...new Uint8Array(valid.data)],[1,2,3,4]);assert.equal(valid.ext,'.png');assert.equal(valid.isWxgf,true);checks++;
  const absent=await workerReply(path.join(result,'absent.node'));assert.equal(absent.id,31);assert.equal(absent.ok,false);assert.equal(absent.addonMissing,true);checks++;
  fs.writeFileSync(addon,"module.exports={decryptDatNative:()=>{throw Error('synthetic failure')}};");
  const failed=await workerReply(addon);assert.equal(failed.ok,false);assert.match(failed.error,/synthetic failure/);checks++;
  fs.writeFileSync(path.join(result,'worker-contract.json'),JSON.stringify({success:true,checks,...mismatch},null,2));
  console.log(JSON.stringify({success:true,checks,...mismatch}));
 }finally{fs.rmSync(addon,{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
