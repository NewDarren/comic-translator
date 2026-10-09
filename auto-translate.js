// Schedule only the latest visible page and serialize model requests.
export function createAutoQueue({select,run,delay=600,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer=null, running=false, active=false;
  function request(wait=delay) {
    active=true;
    if(timer!==null){clearTimer(timer);timer=null;}
    if(running)return;
    timer=setTimer(async()=>{
      timer=null;
      if(!active||running)return;
      const candidate=select();
      if(candidate===null||candidate===undefined)return;
      running=true;
      try{await run(candidate);}
      catch{active=false;}
      finally{running=false;if(active)request(0);}
    },Math.max(0,wait));
  }
  function stop(){active=false;if(timer!==null){clearTimer(timer);timer=null;}}
  return {request,stop};
}
