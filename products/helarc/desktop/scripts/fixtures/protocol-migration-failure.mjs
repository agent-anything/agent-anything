import Database from "better-sqlite3";
const original=Database.prototype.exec;
Database.prototype.exec=function(sql){
  if(sql.includes("CREATE TABLE protocol_contents")){
    original.call(this,sql.slice(0,sql.indexOf("CREATE TABLE protocol_records")));
    throw new Error("fixture_interrupted_additive_migration");
  }
  return original.call(this,sql);
};
await import("../../dist/main/execution-storage/ExecutionStoreWorker.js");
