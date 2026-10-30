(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.QSSSuperChat=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const colors=['#1565c0','#00e5ff','#0f9d58','#ffca28','#f57c00','#e91e63','#e62117'];
function color(event){
 if(/^#[0-9a-f]{6}$/i.test(event.color||''))return event.color;
 if(Number.isInteger(event.tier)&&event.tier>0)return colors[Math.min(event.tier,7)-1];
 if(event.currency==='USD'){const n=Number(event.amount);return colors[n>=100?6:n>=50?5:n>=20?4:n>=10?3:n>=5?2:n>=2?1:0]}
 return '#303846';
}
function active(events,now){return(events||[]).find(x=>x.startsAt<=now&&x.endsAt>now)||null}
return{color,active};
});
