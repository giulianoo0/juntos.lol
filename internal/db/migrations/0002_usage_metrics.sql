-- How the site was used, one number per metric per day (Brasília). Totals
-- only: who came is never kept, the distinct counts come from HyperLogLog
-- sketches that never leave Redis.
CREATE TABLE usage_metrics (
    day    date   NOT NULL,
    metric text   NOT NULL,
    value  bigint NOT NULL,
    PRIMARY KEY (day, metric)
);
