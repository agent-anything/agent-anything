const {createHash}=require("node:crypto");
const columns={
  product_admissions:"root_run_id,digest,delivered",run_tree_commits:"record_id,digest",
  execution_commits:"record_id,digest",action_records:"record_id,digest",
  activity_paths:"id,digest,progress_revision,progress",activity_stages:"id,digest,status,attempt_id,result_id,receipt_id",
  activity_attempts:"id,digest",activity_raw_results:"id,digest",activity_processing_receipts:"id,digest",
};
exports.facts=db=>Object.fromEntries(Object.entries(columns).map(([table,fields])=>{
  const hash=createHash("sha256");let count=0;
  for(const row of db.prepare("SELECT "+fields+" FROM "+table+" ORDER BY "+fields.split(",")[0]).iterate()){
    hash.update(JSON.stringify(row)+"\n");count++;
  }
  return [table,{count,digest:hash.digest("hex")}];
}));

// New independent Runs may add rows. Each original key must still have its original facts.
exports.checkOriginalRows=(original,current)=>{
  const assert=require("node:assert/strict"),counts={};
  for(const [table,fields] of Object.entries(columns)){
    const key=fields.split(",")[0],lookup=current.prepare("SELECT "+fields+" FROM "+table+" WHERE "+key+"=?");
    counts[table]=0;
    for(const row of original.prepare("SELECT "+fields+" FROM "+table).iterate()){
      assert.deepEqual(lookup.get(row[key]),row,table+":"+row[key]);counts[table]++;
    }
  }
  for(const {run_id} of original.prepare("SELECT run_id FROM run_tree_members").iterate()){
    for(const [table,key] of [["execution_commits","owner_id"],["action_records","run_id"]]){
      const sql="SELECT count(*) n FROM "+table+" WHERE "+key+"=?";
      assert.equal(current.prepare(sql).get(run_id).n,original.prepare(sql).get(run_id).n);
    }
  }
  return counts;
};
