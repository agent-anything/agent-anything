import { NativeProtocolError } from "./NativeJson.js";
export function nativeHttpEndpoint(baseUrl:string,path:string):string {
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search||url.hash||
    (url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))))
    throw new NativeProtocolError("native_connection_invalid");
  url.pathname=`${url.pathname.replace(/\/$/,"")}/${path}`;return url.toString();
}
