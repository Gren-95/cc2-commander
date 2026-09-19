/**
 * Human-readable names for CC2 MQTT method codes, for the log viewer.
 *
 * **Treat an entry here as a label, not as a citation.** Several were wrong, and
 * because this is the most readable list of methods in the repo it is where uncited
 * claims got copied from — ELEG-38 asked for a history delete on 1049, ELEG-30 for AI
 * detection on 2010/2011, and ELEG-32 for OTA on 1064, all of which trace back to this
 * table. `data/CC2_PROTOCOL_REFERENCE.md` is the citable source; ELEG-57 audits the
 * rest of this table against it.
 *
 * **The rows corrected from upstream (`runnane/elegoo-web`, its ELEG-85 and ELEG-100)
 * are that project's reading of the firmware's own method enum, and have not been
 * re-verified here** — this clone has no `data/` to check them against. What *is*
 * verified locally: `SUB_STATUS_NAMES` in `src/types.ts` already owns 1061–1064 and 1066
 * as sub-statuses ('Extruder Loading', 'Filament Change', …), so a method label on one of
 * those numbers was a sub-status name copied across, not a method. Upstream also found
 * that where the reference and the running code disagree the code is the stronger
 * evidence — this service sends 2006 for mono filament and reads a video URL out of
 * 1050's reply, both of which the reference names differently — so a row moves only when
 * the reference contradicts it *and* nothing here relies on the old meaning.
 */

export const METHOD_NAMES: Record<number, string> = {
  1001: 'GetAttributes',
  1002: 'GetStatus',
  // Was labelled at 1066, which is the 'Filament Change' sub-status (SUB_STATUS_NAMES in
  // src/types.ts) with an unrelated name pasted onto it. Upstream ELEG-100.
  1004: 'GetFanStatus',
  // Same shape: was labelled at 1065, which is not a method upstream's firmware enum knows.
  1006: 'GetHomeStatus',
  1007: 'EmergencyStop',
  1020: 'StartPrint',
  1021: 'PausePrint',
  1022: 'CancelPrint',
  1023: 'ResumePrint',
  1026: 'HomeControl',
  1027: 'MoveControl',
  1028: 'TempControl',
  1029: 'LightSwitch',
  1030: 'FanControl',
  1031: 'SpeedControl',
  1032: 'AutoLevel',
  1033: 'VibrationOptimize',
  1034: 'PIDDetect',
  1035: 'SelfCheck',
  1036: 'PrintTaskList',
  1037: 'PrintTaskDetail',
  1038: 'HistoryDelete',
  // Was labelled at 1064, which is the 'Extruder Unload Complete' sub-status
  // (SUB_STATUS_NAMES in src/types.ts), not a method — ELEG-32 was written against 1064
  // because of this row. Do NOT send 1039: it starts a firmware flash.
  1039: 'OTAUpgrade',
  1043: 'SetDeviceName',
  1044: 'GetFileList',
  1045: 'GetThumbnail',
  1046: 'GetFileDetail',
  1047: 'DeleteFile',
  // Was 'GetDiskInfo' while 1061 below claimed 'GetCapacity' — one operation under two
  // numbers. The service sends 1048 for storage capacity, so the code agrees with this
  // label (upstream ELEG-85).
  1048: 'GetCapacity',
  // Was 'DeleteHistory', which collided with 1038 above — one operation, two entries,
  // so one had to be wrong. Both protocol docs in `data/` say 1049 is UpdateToken, and
  // ELEG-38 nearly sent a history-delete payload to it (ELEG-38).
  1049: 'UpdateToken',
  1050: 'GetVideoUrl',
  1051: 'GetTimeLapse',
  // There is no 1060: it was labelled 'SetDeviceName', which is 1043 above, and ELEG-39
  // was written against 1060 because of it.
  //
  // 1061 was labelled 'GetCapacity', which is 1048. Upstream's reference names 1061
  // GetMonoFilamentInfo, but nothing here has seen it answer — and this firmware already
  // disagrees with that reference about mono filament (the service uses 2006) — so the
  // name carries a '?' like 1062's. It is also the 'Extruder Loading' sub-status.
  1061: 'GetMonoFilamentInfo?',
  // NOT "GetSystemInfo" — that label was never verified against a real response, and
  // both protocol docs in data/ name 1062 GetAIDetectionSettings. A read-only probe of
  // the live printer answers:
  //
  //     { "id": 25, "method": 1062, "result": { "error_code": 1100 } }
  //
  // every time, so nothing here has ever seen what it returns. **error_code 1100 is
  // undocumented** — it is in no error table in this repo. Best guess, unconfirmed, is
  // "feature unavailable on this machine" rather than "unknown method"; seeing 1100 come
  // back from some *other* method would confirm that.
  //
  // This comment is the only committed record of the above: `data/` is gitignored in its
  // entirety, so the protocol references CLAUDE.md tells you to cite are not in a clone
  // (ELEG-66).
  //
  // The service no longer sends 1062 (ELEG-55); this entry stays only so the log viewer
  // can label one if the touchscreen or some other client sends it. ELEG-56 is the
  // capture that would settle the real name. Do NOT send 1063 to find out what it does —
  // it is a `Set…`.
  1062: 'GetAIDetectionSettings?',
  // Was 'MessageAutoReport', but the auto-report is 6000 (StatusEvent below). Upstream's
  // reference instead names 1063 SetAIDetectionSettings; here it is only ever seen as the
  // 'Extruder Load Complete' sub-status. '?' as with 1061/1062, since nothing here has
  // seen it answer as a method. Do NOT send 1063 — it is a `Set…`.
  //
  // 1064, 1065 and 1066 are no longer listed: they were OTAUpgrade, GetHomeStatus and
  // GetFanInfo, all flatly wrong copies of sub-status numbers, moved to 1039, 1006 and
  // 1004 above.
  1063: 'SetAIDetectionSettings?',
  2001: 'LoadFilament',
  2002: 'UnloadFilament',
  2003: 'SetFilamentInfo',
  2004: 'SetAutoRefill',
  2005: 'GetCanvasInfo',
  2006: 'GetMonoFilament',
  // Absent from upstream's reference and firmware enum — but so is 2006 above, which this
  // service sends and the printer answers, so absence alone is not enough to delete it.
  // Marked '?' until a capture settles it (ELEG-56).
  2007: 'SetMonoFilament?',
  // 2010 and 2011 ('AIDetectionGet'/'AIDetectionSet') are gone: in no reference, no
  // firmware enum and no local capture. They were guessed for ELEG-30, and this table is
  // where that guess got copied from.
  6000: 'StatusEvent',
};
