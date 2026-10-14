# 运动数据库完整方案 v2（终版：公开仓 + 全进仓 + 图片/GPX/TCX/KML 四入口）

日期：2026-10-14
约束：SQL(SQLite) + 小米运动健康为主 + GitHub公开仓库即后端 + 全量git + 几十年<1G + PWA前端

## 1. 总架构

```
小米App / 手表
 ├─ A 图片截图 ─┐
 ├─ B 单次 GPX/TCX/KML 导出 ─┼─> PWA(github pages) -> inbox/ -> Actions(解析/AI) -> data/ + tracks/ + images/ -> build data.db -> Pages查 + reports/
 └─ C 季度隐私备份zip ─┘
```

真相源 = git里的CSV + tracks + images，data.db是CI构建产物（也进仓，方便直接下载查）。

## 2. 公开仓策略

- 新建公开仓 `sport-db`，MIT协议。
- 入库前脱敏：Uid/Sid/Did/Identifier/GalaxyAccessKey全部去掉或sha256前8位代替，设备名`REDMI K80`泛化为`android-phone`，GPX链接的签名参数去掉只留路径，体重/经纬度轨迹做偏移（起点漂移200m）。
- 不存解压密码、Token、邮箱。Actions用Secrets存LLM Key。
- README带徽章：总数/今年km/连续周 + 数据字典 + 导入教程。

## 3. 全进仓存储布局（压+拆，保证<1G）

```
sport-db/
  data/workouts/2023.csv,2024.csv,2025.csv,2026.csv   # sport_record按年拆，一年~150KB
  data/daily/2023.csv ...                             # aggregated日报按年拆，一年~600KB
  data/raw/fitness/2026/10.csv.gz                     # 113MB大文件拆成一月一压，一包2-3MB
  tracks/gpx/2026/10/13-outdoor_running.gpx           # 672个+以后单次导入的，原样放
  tracks/tcx/, tracks/kml/                            # 同上，按格式分目录
  images/2026/10/13-01.webp                           # 截图压1280px+WebP<300KB
  inbox/uploads/*.jpg,*.gpx,*.tcx,*.kml               # PWA上传暂存，Actions消费后删除/归档
  data.db                                             # CI合成，几MB，也进仓
  reports/daily/2026-10-13.md, weekly/*.md
  frontend/                                           # PWA源码，发布到gh-pages分支
  scripts/
    import_mi.py      # 备份zip -> data/ 的清洗（含去2000年脏数据、+8h时区、脱敏）
    parse_track.py    # gpx/tcx/kml统一解析 -> {distance,duration,avg_hrm,avg_pace,steps,start_time}
    ai_image.py       # 图片 -> json {type,distance,duration,pace,hr,cal,confidence}
    build_db.py       # csv+tracks -> data.db (workouts, daily_metrics, meta, files)
    download_gpx.py   # track_data.csv里的672链接批量下载（趁2027-01过期前）
  .github/workflows/sync.yml  # push/inbox/daily cron三触发
```

体量预算（已按你的包实测）：
历史807条486KB + 日报2MB + GPX约130MB + 图以后一年100MB + raw压后一年~30MB → 首年~270MB，之后一年~40MB（图+gpx为主），10年~650MB，20年~1G临界。超1G前把`data/raw`转LFS或拆新仓`.sport-db-archive`即可，查询层不动。

单文件红线：113MB原文件禁止直push，必须拆+gz，保证单文件<10MB。

## 4. 四入口导入设计（你要的重点）

### 4.1 图片导入（每天用，10秒）
PWA页 `今天 -> 拍照/选图`：
1. 前端压图（canvas 1280px + webp 0.8）→ POST到 `inbox/uploads/20261014-001.jpg`（经GitHub API，需细粒度Token只给此仓contents:write）。
2. Actions触发 `ai_image.py`：Vision模型Prompt固定提取`type/distance_km/duration_s/avg_pace_s_per_km/avg_hr/cal/steps/cadence`，返回json+confidence。
3. confidence>=0.8直接写入`data/workouts/当年.csv`一行 + 原图移`images/年/月/日-序号.webp`；<0.8进`review/`，PWA标黄你点一下确认。
4. 小米截图版式已适配：顶部距离/时长/配速，中部心率曲线，底部卡路里/步频。Keep/悦跑圈同样Prompt兼容。

### 4.2 GPX/TCX/KML单次导入（比赛/要轨迹时用）
PWA页 `导入 -> 选文件(.gpx/.tcx/.kml)`：
1. 上传到`inbox/uploads/`，Actions跑`parse_track.py`：
   - gpx: `<trkpt lat lon><ele><time>` + `<extensions>心率`，算距离(Haversine)、时长、配速。
   - tcx: `<Lap><DistanceMeters><TotalTimeSeconds><AverageHeartRateBpm>`，最准，直接取。
   - kml: `<coordinates>`+`<TimeStamp>`，无心率则hr=null。
2. 去重键 `start_time+type+distance`，已存在则覆盖修正（解决截图记错）。
3. 原文件移`tracks/{gpx,tcx,kml}/年/月/日-类型.扩展名`，解析json追加csv，重编db。
4. 单次就单次，不攒批量，跑完顺手传，和图片同权。三种格式统一成同一workouts schema，缺字段null。

### 4.3 季度备份包校准
每季度下一次隐私zip，跑`import_mi.py`全量diff：新Sid追加，旧Sid的Value变了则更新，GPX链接新的则`download_gpx.py`补下。截图的confidence低的会被备份包自动修正。

### 4.4 672旧GPX抢救
`track_data.csv`里的链接`Expires=1799713932000`（2027-01过期），第一批任务就是批量下载进`tracks/gpx/`，失败重试3次，记录`download_log.csv`。

## 5. SQL表（SQLite，3张+1视图）

```sql
workouts(id TEXT PK, date TEXT, start_time INT, type TEXT, distance_m INT, duration_s INT,
 avg_pace_s INT, avg_hr INT, max_hr INT, min_hr INT, calories INT, steps INT, cadence INT,
 source TEXT, -- image/gpx/tcx/kml/mi_backup
 file_path TEXT, confidence REAL, note TEXT);
daily_metrics(date TEXT PK, steps INT, calories INT, sleep_min INT, stress_avg INT,
 resting_hr INT, weight_kg REAL, spo2_avg INT);
meta(key TEXT PK, value TEXT); -- goals, max_hr 190, init_weight 60
files(path TEXT PK, sha256 TEXT, bytes INT, imported_at TEXT);
CREATE INDEX idx_workouts_date ON workouts(date);
CREATE INDEX idx_workouts_type ON workouts(type);
```

## 6. 前端PWA（Pages）
4页：今天（上传+导入+今日建议）、日历（贡献图）、趋势（Echarts配速/心率/跑量，抄statistics-for-strava）、年报（海报分享）。
查询用sql.js-httpvfs按需读db页，不全量下载。支持Share Target：小米点分享直跳PWA。

## 7. AI建议
每晚Actions cron：读最近7/30天workouts+daily → LLM生成`reports/daily/xx.md`（涨量>20%预警、配速-心率漂移、睡眠不足提示、下周计划）。月末生成月报。Prompt与解析Prompt分离，省钱。

## 8. 不崩保障
- 小文件追加，无大文件重写；`vacuum+page_size=1024+索引`优化httpvfs；db损坏CI重建。
- 每周`git gc`，每月打tag `backup-2026-10`，每年切新csv。
- Actions幂等+去重+失败进`quarantine/`不阻塞。

## 9. 里程碑
M1 历史入库：洗807+672GPX下载+首版db+Pages上线
M2 双入口：图片AI+单文件解析上线
M3 建议：日报/周报+年报海报
M4 季度校准自动化

## 10. 待你拍板
- 已定：公开、全进仓、四入口。
- 下一步：我按M1开干，先给你首版db+Pages预览，是否开始？
