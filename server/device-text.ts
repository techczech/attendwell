// The iPad refuses a whole answer that holds an email-like value (DeviceProtocol.privacyViolations, /[^\s@]+@[^\s@]+\.[^\s@]+/).
// Here only ASCII spaces separate words, so this matches everything the iPad's pattern matches (its \s is wider) and a little more.
export const EMAIL_LIKE=/[^@ \t\n\r\f\v]+@[^@ \t\n\r\f\v]+\.[^@ \t\n\r\f\v]+/;
// Device-visible text: an email-like value drops every word holding an @, then empty brackets and stray separators left behind.
// The remaining words hold no @, so the result can never look like an address. Text without an address is returned unchanged.
export function deviceText(x:string,fallback:string){
 if(!EMAIL_LIKE.test(x))return x;
 // Odd parts are separators (spaces, brackets, quotes, commas) and never hold an @; even parts holding one are dropped.
 const out=x.split(/([ \t\n\r\f\v<>()[\]{}"',;]+)/).map((w,i)=>i%2||!w.includes('@')?w:'').join('')
  .replace(/<\s*>|\(\s*\)|\[\s*\]|\{\s*\}|"\s*"|'\s*'/g,' ').replace(/\s+/g,' ').replace(/ ([,;)\]}>])/g,'$1').replace(/([(\[{<]) /g,'$1').replace(/^[\s,;:|\-\u2013\u2014]+|[\s,;:|\-\u2013\u2014]+$/g,'');
 return out||fallback;
}
export const HIDDEN_NAME='Name hidden';
