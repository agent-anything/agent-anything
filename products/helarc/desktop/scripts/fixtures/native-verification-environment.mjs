export function nativeVerificationEnvironment(options){
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    !/^(?:HELARC_VERIFICATION_.*|HELARC_P05_LIFETIME|ELECTRON_RUN_AS_NODE)$/i.test(key)));
  return {...env,...options};
}
