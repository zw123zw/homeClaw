# 0002 数据表用 SQLite（node:sqlite）而非 Postgres

一客户一盒子的交付形态下，每个盒子只有一套家庭数据、一个写入进程。SQLite 在 WAL 模式下足以支撑；用 Node 内置 `node:sqlite` 可避免原生模块编译，盒子镜像体积和部署复杂度都显著降低。代价是放弃跨盒子的集中查询与连接池，运维统计需靠日志汇总而非直连数据库。

**Status**: accepted