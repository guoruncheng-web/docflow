-- An approval pointed at its approver with ON DELETE RESTRICT, which made any
-- demo workspace containing an approval impossible to delete. Reaping runs
-- before a workspace is provisioned, so a single such row failed every later
-- POST /api/demo/session with a foreign key error.
--
-- Approvals already cascade from the record they approved; cascading from the
-- approver as well is the same rule applied to the other parent.
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_user_id_fkey";

ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
