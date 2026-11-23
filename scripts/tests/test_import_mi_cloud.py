"""P1 数据管道回归：多源去重、睡眠聚合、配对、series 合并、动态列。"""
import csv
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import import_mi_cloud as m  # noqa: E402

BJ = timezone(timedelta(hours=8))


def noon(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=BJ).timestamp()) + 12 * 3600


class AggregateDailyTest(unittest.TestCase):
    def test_multi_source_steps_not_summed(self):
        t = noon("2026-11-22")
        data = {"steps": [
            {"time": t, "sid": "hlth.gen_1", "value": json.dumps({"steps": 100, "distance": 80, "calories": 5})},
            {"time": t, "sid": "watch", "value": json.dumps({"steps": 90, "distance": 70, "calories": 4})},
        ]}
        rows = m.aggregate_daily(data)
        step = next(r for r in rows if r["key"] == "steps")
        self.assertEqual(step["value"]["steps"], 100)
        self.assertEqual(step["value"]["distance"], 80)

    def test_sleep_aggregated_with_segment_details(self):
        wake = int(datetime(2026, 11, 22, 7, 0, tzinfo=BJ).timestamp())
        bed = wake - 2 * 3600
        data = {"sleep": [{"time": wake, "sid": "watch", "value": json.dumps({
            "bedtime": bed, "wake_up_time": wake, "duration": 7200,
            "sleep_deep_duration": 2400, "sleep_light_duration": 3600,
            "sleep_rem_duration": 1200, "sleep_awake_duration": 0, "sleep_score": 80,
        })}]}
        row = next(r for r in m.aggregate_daily(data) if r["key"] == "sleep")
        self.assertEqual(row["date"], "2026-11-22")
        v = row["value"]
        self.assertEqual(v["duration"], 120)
        self.assertEqual(len(v["segment_details"]), 1)
        self.assertEqual(v["deep"], 40)
        self.assertEqual(v["light"], 60)
        self.assertEqual(v["rem"], 20)
        self.assertEqual(v["sleep_score"], 80)

    def test_short_sleep_dropped(self):
        wake = int(datetime(2026, 11, 22, 7, 0, tzinfo=BJ).timestamp())
        data = {"sleep": [{"time": wake, "sid": "watch", "value": json.dumps({
            "bedtime": wake - 1800, "wake_up_time": wake, "duration": 1800,
        })}]}
        self.assertFalse([r for r in m.aggregate_daily(data) if r["key"] == "sleep"])

    def test_sleep_sources_deduped_and_nap_skipped(self):
        wake = int(datetime(2026, 11, 23, 7, 0, tzinfo=BJ).timestamp())
        bed = wake - 8 * 3600

        def sample(sid, deep):
            return {"time": wake, "sid": sid, "value": json.dumps({
                "bedtime": bed, "device_wake_up_time": wake, "duration": 480,
                "sleep_deep_duration": deep * 60, "sleep_light_duration": 300 * 60,
                "sleep_rem_duration": 60 * 60, "sleep_awake_duration": 30 * 60,
            })}

        data = {"sleep": [
            sample("hlth.gen_1", 90),
            sample("hlth.gen_1", 90),  # 同一段，去重
            sample("watch", 10),       # 不选这个来源，更不能相加
            {"time": wake, "sid": "hlth.gen_1", "value": json.dumps({
                "bedtime": wake - 1800, "wake_up_time": wake,
                "duration": 30, "is_nap": 1})},
        ]}
        rows = [r for r in m.aggregate_daily(data) if r["key"] == "sleep"]
        self.assertEqual(len(rows), 1)
        v = rows[0]["value"]
        self.assertEqual((v["duration"], v["deep"]), (480, 90))
        self.assertEqual(len(v["segment_details"]), 1)

    def test_spo2_avg_min_max(self):
        t = noon("2026-11-23")
        data = {"spo2": [
            {"time": t, "sid": "hlth.gen_1", "value": json.dumps({"spo2": 96})},
            {"time": t + 60, "sid": "hlth.gen_1", "value": json.dumps({"spo2": 99})},
            {"time": t, "sid": "watch", "value": json.dumps({"spo2": 70})},
            {"time": t + 120, "sid": "hlth.gen_1", "value": json.dumps({"spo2": 0})},
        ]}
        row = next(r for r in m.aggregate_daily(data) if r["key"] == "spo2")
        v = row["value"]
        self.assertEqual((v["avg_spo2"], v["min_spo2"], v["max_spo2"]), (98, 96, 99))


class MergeWorkoutsTest(unittest.TestCase):
    def _cloud(self, start: str) -> dict:
        return {
            "id": "new", "date": "2026-11-22", "type": "outdoor_running",
            "distance_m": "1000", "start_utc": start, "sid_hash": "h2",
            "source": "mihealth-cloud", "value_json": "{}",
        }

    def test_start_time_constraint_merges_near(self):
        rows = [{"id": "old", "date": "2026-11-22", "type": "outdoor_running",
                 "distance_m": "1000", "start_utc": "1000", "sid_hash": "h1",
                 "source": "mihealth-cloud"}]
        rep = {"added": 0, "merged": 0}
        out = m.merge_workouts(rows, [self._cloud("1100")], rep)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "old")
        self.assertEqual(out[0]["start_utc"], "1100")
        self.assertEqual(rep["merged"], 1)

    def test_far_start_adds_new(self):
        rows = [
            {"id": "old1", "date": "2026-11-22", "type": "outdoor_running",
             "distance_m": "1000", "start_utc": "1000", "sid_hash": "h1",
             "source": "mihealth-cloud"},
            {"id": "old2", "date": "2026-11-22", "type": "outdoor_running",
             "distance_m": "1000", "start_utc": "5000", "sid_hash": "h1",
             "source": "mihealth-cloud"},
        ]
        rep = {"added": 0, "merged": 0}
        out = m.merge_workouts(rows, [self._cloud("9000")], rep)
        self.assertEqual(len(out), 3)
        self.assertEqual(rep["added"], 1)

    def test_reimport_same_id_does_not_duplicate(self):
        rows = [
            {"id": "old1", "date": "2026-11-22", "type": "outdoor_running",
             "distance_m": "1000", "start_utc": "1000", "sid_hash": "h1",
             "source": "mihealth-cloud"},
            {"id": "old2", "date": "2026-11-22", "type": "outdoor_running",
             "distance_m": "1000", "start_utc": "1100", "sid_hash": "h1",
             "source": "mihealth-cloud"},
        ]
        cloud = self._cloud("1050")  # 两个候选都在 10 分钟内 -> 先新增
        rep1 = {"added": 0, "merged": 0}
        rows = m.merge_workouts(rows, [cloud], rep1)
        self.assertEqual(rep1["added"], 1)
        rep2 = {"added": 0, "merged": 0}
        rows = m.merge_workouts(rows, [cloud], rep2)
        self.assertEqual(rep2["added"], 0)  # 同 id 已存在，不重复追加
        self.assertEqual(len(rows), 3)


class MergeSeriesTest(unittest.TestCase):
    def test_empty_new_keeps_old(self):
        old = [{"workout_id": "w", "date": "2026-11-22", "minute": "100",
                "t_beijing": "21:01", "hr": "140", "cadence": "170"}]
        new = [
            {"workout_id": "w", "date": "2026-11-22", "minute": "100",
             "t_beijing": "21:01", "hr": "", "cadence": ""},
            {"workout_id": "w", "date": "2026-11-22", "minute": "160",
             "t_beijing": "21:02", "hr": "150", "cadence": "172"},
        ]
        out = m.merge_series(old, new)
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["hr"], "140")
        self.assertEqual(out[1]["hr"], "150")

    def test_rebuild_replaces(self):
        old = [{"workout_id": "w", "date": "2026-11-22", "minute": "100",
                "t_beijing": "21:01", "hr": "140", "cadence": "170"}]
        new = [{"workout_id": "w", "date": "2026-11-22", "minute": "100",
                "t_beijing": "21:01", "hr": "", "cadence": ""}]
        out = m.merge_series(old, new, rebuild=True)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["hr"], "")


class WriteCsvTest(unittest.TestCase):
    def test_empty_rows_not_written(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "y.csv"
            m.write_csv(p, ["a", "b"], [{"a": "1", "b": "2"}, {}, {"a": "", "b": ""}])
            with open(p, encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 1)

    def test_keeps_unknown_columns(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "x.csv"
            m.write_csv(p, ["a", "b"], [{"a": "1", "b": "2"}])
            m.write_csv(p, ["a"], [{"a": "3", "b": "4", "c": "5"}])
            with open(p, encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(list(rows[0].keys()), ["a", "b", "c"])
            self.assertEqual(rows[0]["c"], "5")
            self.assertGreater(p.read_bytes().count(b"\r\n"), 0)


if __name__ == "__main__":
    unittest.main()
