const mime=new Set(["video/mp4","video/quicktime","video/webm","video/x-msvideo","video/mpeg"]);
const ext=new Set([".mp4",".mov",".webm",".avi",".mpeg",".mpg"]);
export function isAllowedVideo(type:string,name:string){const m=type.toLowerCase().split(";")[0]?.trim()??"";const e=name.toLowerCase().slice(name.lastIndexOf("."));return mime.has(m)&&ext.has(e);}
export function safeFilename(name:string){const s=name.normalize("NFKC").replace(/[\\/\\0\\r\\n]/g,"_").replace(/[^a-zA-Z0-9._ -]/g,"").replace(/\\s+/g," ").trim();return(s||"cricket-video.mp4").slice(0,180);}
export function parseMaxUploadBytes(v:string|undefined){const n=Number(v??536870912);return Number.isSafeInteger(n)&&n>0?Math.min(n,5*1024**3):536870912;}