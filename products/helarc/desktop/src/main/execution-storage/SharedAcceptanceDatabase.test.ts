import {describe,expect,it} from "vitest";
import Database from "better-sqlite3";
import {SharedAcceptanceDatabase,SharedAcceptanceRejection,SHARED_ACCEPTANCE_SCHEMA} from "./SharedAcceptanceDatabase.js";

describe("participant-owned common acceptance", () => {
  it("commits together, records known rejection without partial state, and queries lost acknowledgements", () => {
    const db = new Database(":memory:");
    try {
      db.exec(SHARED_ACCEPTANCE_SCHEMA+"CREATE TABLE first_owner(value TEXT); CREATE TABLE second_owner(value TEXT);");
      const shared = new SharedAcceptanceDatabase(db,["first","second"].map(owner => ({owner,kinds:["publish"],
        prepare: part => part.proposal,
        apply: (value,proposal) => {
          if (proposal.actor !== "authorized") throw new SharedAcceptanceRejection(owner,"actor_denied");
          if (value === "reject") throw new SharedAcceptanceRejection(owner,"condition_changed");
          db.prepare(`INSERT INTO ${owner}_owner VALUES (?)`).run(value as string);
        }})));
      const proposal = {id:"accept:1",scope:"run",actor:"authorized",parts:[{owner:"first",kind:"publish",proposal:"a"},{owner:"second",kind:"publish",proposal:"b"}]};
      const receipt = shared.accept(proposal);
      expect(receipt.outcome).toBe("accepted"); expect(shared.query(proposal.id)).toEqual(receipt);
      expect(shared.accept(proposal)).toEqual(receipt);
      expect(db.prepare("SELECT COUNT(*) AS n FROM first_owner").get()).toEqual({n:1});
      expect(() => shared.accept({...proposal,actor:"other"})).toThrow("identity_conflict");
      const rejected = shared.accept({...proposal,id:"accept:2",parts:[proposal.parts[0]!,{owner:"second",kind:"publish",proposal:"reject"}]});
      expect(rejected).toMatchObject({outcome:"rejected",rejection:{owner:"second",code:"condition_changed"}});
      expect(db.prepare("SELECT COUNT(*) AS n FROM first_owner").get()).toEqual({n:1});
      expect(shared.query("missing")).toBeNull();
      db.prepare("UPDATE shared_acceptances SET outcome='rejected' WHERE id=?").run(proposal.id);
      expect(() => shared.query(proposal.id)).toThrow("corrupt");
    } finally {db.close();}
  });
  it("does not convert an unclassified storage failure into a known rejection", () => {
    const db = new Database(":memory:");
    try {
      db.exec(SHARED_ACCEPTANCE_SCHEMA);
      const shared = new SharedAcceptanceDatabase(db,[{owner:"owner",kinds:["publish"],prepare:()=>null,apply:()=>{throw new Error("storage failure");}}]);
      expect(() => shared.accept({id:"unknown",scope:"run",actor:"owner",parts:[{owner:"owner",kind:"publish",proposal:null}]})).toThrow("storage failure");
      expect(shared.query("unknown")).toBeNull();
    } finally {db.close();}
  });
});
