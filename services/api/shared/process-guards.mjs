/** Logs a fatal error and exits, so the container restarts instead of continuing in an unknown state. */
export function installProcessGuards(component,{exit=code=>process.exit(code),write=line=>process.stderr.write(line),target=process}={}){
 const fatal=kind=>error=>{
  write(JSON.stringify({level:'fatal',component,kind,code:error?.code??'internal',message:String(error?.message??error).slice(0,300),time:new Date().toISOString()})+'\n');
  exit(1);
 };
 target.on('unhandledRejection',fatal('unhandled_rejection'));
 target.on('uncaughtException',fatal('uncaught_exception'));
}
