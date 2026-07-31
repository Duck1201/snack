-- Derived prompt-size category.
--
-- The category is a rebuildable projection over the allowlisted input features already
-- stored by migration 004. It is derived in chronological order using only observations
-- that started earlier, so a later prompt can never change an earlier category. The
-- policy version and the baseline timestamp travel with the row so any stored category
-- can be reproduced from the policy that produced it.

ALTER TABLE prompt_execution
  ADD COLUMN size_category TEXT CHECK (size_category IN ('small', 'typical', 'large'));

ALTER TABLE prompt_execution ADD COLUMN category_policy_version TEXT;

ALTER TABLE prompt_execution ADD COLUMN category_baseline_as_of TEXT;
