-- Initial request caps for the small personal deployment. Adjust in the admin after observing usage.
UPDATE budgets SET per_minute=20, per_hour=200, per_day=500,
  note='药研雷达初始调用次数上限；不是金额上限，按实际模型价格另设服务商预算'
WHERE service='llm';
UPDATE budgets SET per_minute=0, per_hour=0, per_day=0
WHERE service IN ('embedding','jina','socialdata','dajiala');
