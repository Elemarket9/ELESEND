/** Time calibration from completed historic trips. Never invent a prediction from an empty bucket. */
export function calibrateETA(providerSeconds,samples,{minSamples=30,maxFactor=1.7,minFactor=.7}={}){
 if(!Number.isFinite(providerSeconds)||providerSeconds<0)throw Error('Invalid routing ETA');
 const verified=(samples??[]).filter(s=>s?.verified===true&&Number.isFinite(s.predictedSeconds)&&s.predictedSeconds>30&&Number.isFinite(s.actualSeconds)&&s.actualSeconds>0&&s.actualSeconds<=86400).slice(-1000);
 if(verified.length<minSamples)return {durationSeconds:Math.ceil(providerSeconds),calibrated:false,sampleCount:verified.length};
 const ratios=verified.map(s=>s.actualSeconds/s.predictedSeconds).filter(x=>x>=.25&&x<=4).sort((a,b)=>a-b);
 if(ratios.length<minSamples)return {durationSeconds:Math.ceil(providerSeconds),calibrated:false,sampleCount:ratios.length};
 const k=Math.floor(ratios.length/2),median=ratios.length%2?ratios[k]:(ratios[k-1]+ratios[k])/2;
 const factor=Math.max(minFactor,Math.min(maxFactor,median));return {durationSeconds:Math.ceil(providerSeconds*factor),calibrated:true,sampleCount:ratios.length,factor};
}
