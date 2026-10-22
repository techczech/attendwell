// Display helpers shared by the organiser register and the participant page. Dates are calendar dates (YYYY-MM-DD).
export const formatWorkshopDate=(date:string,year=true)=>{
 const d=new Date(date+'T12:00:00Z');if(Number.isNaN(d.getTime()))return date;
 return d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',...(year?{year:'numeric'}:{}),timeZone:'UTC'});
};
export const clockTime=(t:number|string)=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
