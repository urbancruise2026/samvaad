const crypto = require("crypto");

const ApiError = require("../../utils/ApiError");
const { normalizeRole, isTopLevel } = require("../../utils/hierarchy.service");
const { getFieldConfig } = require("./Rating.fieldconfig");

const {
  formatName,
  getAllDepartments,
  getDepartmentById,
  getDepartmentsByIds,
  getSubDepartmentsByDepartment,
  getSubDepartmentsByIds,
  getSubDepartmentMap,
  getDirectReports,
  getAllUsersForRating,
  findUserWithManager,
  getRatingRows,
  getRatingRowsForTeam,
  upsertRatingRow,
  getFieldDefsForEmployees,
  replaceFieldDefs,
} = require("./Rating.repository");

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

// Internal module keys (kept from the old code so DB columns still match):
//   sales        -> "Performance"
//   conduct      -> "Conduct & Behaviour"
//   contribution -> "Contribution to Org."
const MODULES = ["sales", "conduct", "contribution"];
const SCORE_COLUMN = {
  sales: "salesScore",
  conduct: "conductScore",
  contribution: "contributionScore",
};

const RATING_BANDS = [
  { key: "SUPER_ACHIEVER", label: "Super Achiever", min: 14, color: "emerald" },
  { key: "EXCELLENT_PERFORMER", label: "Excellent Performer", min: 12, color: "blue" },
  { key: "GOOD_JOB", label: "Good Job", min: 9, color: "amber" },
  { key: "NEED_IMPROVEMENT", label: "Need Improvement", min: 6, color: "orange" },
  { key: "DO_OR_DIE", label: "Do or Die", min: 0, color: "rose" },
];

const getBand = (total) =>
  RATING_BANDS.find((b) => total >= b.min) ?? RATING_BANDS[RATING_BANDS.length - 1];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const round1 = (n) => Math.round(n * 10) / 10;

// The departments table column is `department_name` (MySQL).
const deptName = (d) => d?.department_name ?? d?.name ?? null;

/**
 * Senior -> junior ordering. Lower number = more senior.
 * NOTE: this reads the role LABEL (users.access_role). If you would
 * rather use config/roleHierarchy.js, swap the body of this function.
 */
const roleRank = (role) => {
  const tokens = String(role ?? "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim()
    .split(" ");
  const joined = tokens.join(" ");

  if (tokens.includes("ADMIN")) return 0;
  if (tokens.includes("HOD")) return 1;
  if (tokens.includes("MANAGER")) return 2;
  if (joined.includes("TEAM LEAD") || tokens.includes("TEAMLEAD") || tokens.includes("TL")) return 3;
  return 4;
};

/* ------------------------------------------------------------------ */
/* Field config + entries + scoring                                    */
/* ------------------------------------------------------------------ */

// Custom (per-employee) fields if a senior has saved any, otherwise the
// department defaults from Rating.fieldconfig.js.
const buildFieldConfig = (defs, departmentName) => {
  if (!defs || defs.length === 0) return getFieldConfig(departmentName);

  const config = { sales: [], conduct: [], contribution: [] };
  for (const d of defs) {
    if (!config[d.module]) continue;
    config[d.module].push({
      key: d.key,
      label: d.label,
      ...(d.isNumeric ? { isNumeric: true } : {}),
    });
  }
  return config;
};

// Per-field entries: { [key]: { rating, remarks, value } }.
// Old rows (before this change) only had extraFields / achievementPercent;
// those are folded in as remarks/value so nothing is lost on screen.
const mergeEntries = (row) => {
  if (!row) return {};
  const entries = {};

  const legacy = row.extraFields && typeof row.extraFields === "object" ? row.extraFields : {};
  for (const [key, text] of Object.entries(legacy)) {
    if (typeof text === "string" && text) {
      entries[key] = { rating: null, remarks: text, value: null };
    }
  }
  if (row.achievementPercent != null) {
    entries.achievementPercent = { rating: null, remarks: "", value: row.achievementPercent };
  }

  const current = row.fieldEntries && typeof row.fieldEntries === "object" ? row.fieldEntries : {};
  for (const [key, e] of Object.entries(current)) {
    entries[key] = {
      rating: e?.rating ?? null,
      remarks: e?.remarks ?? "",
      value: e?.value ?? null,
    };
  }

  return entries;
};

// Module score = average of the ratings given to that module's fields
// (unrated fields are ignored). Stays on the 1-5 scale.
const moduleAverage = (fields, entries) => {
  const ratings = (fields ?? [])
    .map((f) => entries?.[f.key]?.rating)
    .filter((r) => Number.isFinite(r));
  if (ratings.length === 0) return null;
  return round1(ratings.reduce((a, b) => a + b, 0) / ratings.length);
};

const computeScores = (config, entries) => {
  const scores = {};
  for (const m of MODULES) scores[SCORE_COLUMN[m]] = moduleAverage(config[m], entries);

  const hasAchievement = MODULES.some((m) => config[m].some((f) => f.key === "achievementPercent"));
  scores.achievementPercent = hasAchievement ? entries.achievementPercent?.value ?? null : null;
  return scores;
};

const totalOf = (scores) =>
  round1((scores.salesScore ?? 0) + (scores.conductScore ?? 0) + (scores.contributionScore ?? 0));

// Rows saved before this change have no fieldEntries - show their stored
// numbers as-is. Everything newer is computed from the entries so it is
// always consistent with the employee's CURRENT field list.
const shapeRow = (row, config) => {
  if (!row) return null;

  const entries = mergeEntries(row);
  const isLegacy = !row.fieldEntries;
  const scores = isLegacy
    ? {
        salesScore: row.salesScore,
        conductScore: row.conductScore,
        contributionScore: row.contributionScore,
        achievementPercent: row.achievementPercent,
      }
    : computeScores(config, entries);

  return {
    ...scores,
    fieldEntries: entries,
    total: totalOf(scores),
    updatedAt: row.updatedAt,
    raterId: row.raterId,
  };
};

const hasScores = (r) =>
  Boolean(r) && [r.salesScore, r.conductScore, r.contributionScore].some((v) => v != null);

// Official result = senior's rating once it has scores, otherwise self.
const getOverall = (self, senior) => {
  const isFinal = hasScores(senior);
  const total = isFinal ? senior.total : self ? self.total : 0;
  return { total, band: getBand(total), isFinal };
};

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

const getDepartmentsService = async () => getAllDepartments();

const getFilterOptionsService = async (viewerId, viewerRole, departmentId) => {
  const role = normalizeRole(viewerRole);

  if (isTopLevel(role)) {
    return {
      showDepartmentFilter: true,
      showSubDepartmentFilter: true,
      departments: await getAllDepartments(),
      subDepartments: await getSubDepartmentsByDepartment(departmentId),
    };
  }

  const reports = await getDirectReports(viewerId);
  if (reports.length === 0) {
    return {
      showDepartmentFilter: false,
      showSubDepartmentFilter: false,
      departments: [],
      subDepartments: [],
    };
  }

  const subMap = await getSubDepartmentMap(reports.map((r) => r.id));
  const subDepartments = await getSubDepartmentsByIds([...subMap.values()].map((s) => s.id));

  return {
    showDepartmentFilter: false,
    showSubDepartmentFilter: subDepartments.length > 0,
    departments: [],
    subDepartments,
  };
};

const getFieldConfigService = async (departmentId) => {
  const dept = await getDepartmentById(departmentId);
  return { department: dept, fields: getFieldConfig(deptName(dept)) };
};

const getEmployeeRatingService = async (viewerId, viewerRole, employeeId, period) => {
  const employee = await findUserWithManager(employeeId);
  if (!employee) throw new ApiError(404, "Employee not found.");

  const role = normalizeRole(viewerRole);
  const isSelf = Number(viewerId) === Number(employeeId);
  const isDirectManager = Number(employee.manager_id) === Number(viewerId);

  if (!isSelf && !isDirectManager && !isTopLevel(role)) {
    // Further up the same chain (e.g. Manager viewing someone two levels down).
    let current = employee;
    let allowed = false;
    for (let i = 0; i < 10 && current?.manager_id; i++) {
      if (Number(current.manager_id) === Number(viewerId)) {
        allowed = true;
        break;
      }
      current = await findUserWithManager(current.manager_id);
    }
    if (!allowed) throw new ApiError(403, "You are not allowed to view this person's rating.");
  }

  const [rows, dept, defs, subMap] = await Promise.all([
    getRatingRows(employee.id, period),
    getDepartmentById(employee.department_id),
    getFieldDefsForEmployees([employee.id]),
    getSubDepartmentMap([employee.id]),
  ]);

  const departmentName = deptName(dept);
  const fields = buildFieldConfig(defs, departmentName);
  const sub = subMap.get(Number(employee.id)) ?? null;

  const self = shapeRow(rows.find((r) => r.raterType === "SELF"), fields);
  const senior = shapeRow(rows.find((r) => r.raterType === "SENIOR"), fields);

  // Nobody rates themselves as their own "senior" - not even an admin.
  const canEditSenior = !isSelf && (isDirectManager || isTopLevel(role));

  return {
    employee: {
      id: employee.id,
      fullName: formatName(employee),
      role: employee.access_role,
      departmentId: employee.department_id,
      departmentName,
      subDepartmentId: sub?.id ?? null,
      subDepartmentName: sub?.name ?? null,
    },
    period,
    fields,
    self,
    senior,
    overall: getOverall(self, senior),
    canEditSelf: isSelf,
    canEditSenior,
    canEditFields: canEditSenior,
  };
};

/**
 * Team grid: viewer's own row + direct reports (everyone for top-level
 * roles), optional department / sub-department filter, sorted senior ->
 * junior (then by name).
 */
const getTeamRatingService = async (viewerId, viewerRole, { department, subDepartment, period }) => {
  const role = normalizeRole(viewerRole);
  const departmentFilter = isTopLevel(role) ? department : undefined;

  const reports = isTopLevel(role)
    ? await getAllUsersForRating(departmentFilter, subDepartment)
    : await getDirectReports(viewerId, departmentFilter, subDepartment);

  // Everyone sees their own record too, so people with no reports can still self-rate.
  const self = await findUserWithManager(viewerId);

  // With a department / sub-department filter, only show the viewer's own
  // row if they actually belong to it - otherwise the filter would mislead.
  let includeSelf = Boolean(self);
  if (self && departmentFilter && Number(self.department_id) !== Number(departmentFilter)) {
    includeSelf = false;
  }
  if (self && includeSelf && subDepartment) {
    const mine = (await getSubDepartmentMap([viewerId])).get(Number(viewerId));
    if (!mine || Number(mine.id) !== Number(subDepartment)) includeSelf = false;
  }

  const employees = includeSelf
    ? [self, ...reports.filter((r) => Number(r.id) !== Number(viewerId))]
    : reports;

  if (employees.length === 0) {
    return {
      employees: [],
      teamAverage: 0,
      period,
      bandSummary: RATING_BANDS.map((b) => ({ ...b, count: 0 })),
    };
  }

  const employeeIds = employees.map((e) => e.id);

  const [rows, deptMap, defs, subMap] = await Promise.all([
    getRatingRowsForTeam(employeeIds, period),
    getDepartmentsByIds(employees.map((e) => e.department_id)),
    getFieldDefsForEmployees(employeeIds),
    getSubDepartmentMap(employeeIds),
  ]);

  const defsByEmployee = new Map();
  for (const d of defs) {
    if (!defsByEmployee.has(d.employeeId)) defsByEmployee.set(d.employeeId, []);
    defsByEmployee.get(d.employeeId).push(d);
  }

  const finalTotals = [];
  const bandCounts = Object.fromEntries(RATING_BANDS.map((b) => [b.key, 0]));

  const shaped = employees.map((emp) => {
    const dept = deptMap.get(Number(emp.department_id)) ?? null;
    const departmentName = deptName(dept);
    const sub = subMap.get(Number(emp.id)) ?? null;
    const fields = buildFieldConfig(defsByEmployee.get(emp.id), departmentName);

    const empRows = rows.filter((r) => r.employeeId === emp.id);
    const selfRow = shapeRow(empRows.find((r) => r.raterType === "SELF"), fields);
    const seniorRow = shapeRow(empRows.find((r) => r.raterType === "SENIOR"), fields);

    const overall = getOverall(selfRow, seniorRow);
    if (overall.isFinal) {
      bandCounts[overall.band.key] += 1;
      finalTotals.push(overall.total);
    }

    const canEditSenior = Number(emp.id) !== Number(viewerId);

    return {
      id: emp.id,
      fullName: formatName(emp),
      role: emp.access_role,
      departmentId: emp.department_id,
      departmentName,
      subDepartmentId: sub?.id ?? null,
      subDepartmentName: sub?.name ?? null,
      fields,
      self: selfRow,
      senior: seniorRow,
      overall,
      canEditSenior,
      canEditFields: canEditSenior,
    };
  });

  shaped.sort((a, b) => {
    const diff = roleRank(a.role) - roleRank(b.role);
    return diff !== 0 ? diff : a.fullName.localeCompare(b.fullName);
  });

  // Average of OFFICIAL totals only (no more mixing self + senior rows).
  const teamAverage = finalTotals.length
    ? Number((finalTotals.reduce((a, b) => a + b, 0) / finalTotals.length).toFixed(1))
    : 0;

  return {
    employees: shaped,
    teamAverage,
    period,
    bandSummary: RATING_BANDS.map((b) => ({ ...b, count: bandCounts[b.key] })),
  };
};

/* ------------------------------------------------------------------ */
/* Saving ratings                                                      */
/* ------------------------------------------------------------------ */

const saveRating = async ({ raterType, raterId, employee, period, incoming }) => {
  const [dept, defs, rows] = await Promise.all([
    getDepartmentById(employee.department_id),
    getFieldDefsForEmployees([employee.id]),
    getRatingRows(employee.id, period),
  ]);

  const config = buildFieldConfig(defs, deptName(dept));
  const allowedKeys = new Set(MODULES.flatMap((m) => config[m].map((f) => f.key)));

  const existing = rows.find((r) => r.raterType === raterType);
  const entries = mergeEntries(existing);

  // Merge per field, so two quick edits to different fields never overwrite each other.
  for (const [key, patch] of Object.entries(incoming ?? {})) {
    if (!allowedKeys.has(key)) {
      throw new ApiError(400, `"${key}" is not a rating field for this employee.`);
    }
    entries[key] = {
      ...(entries[key] ?? { rating: null, remarks: "", value: null }),
      ...patch,
    };
  }

  const scores = computeScores(config, entries);

  const row = await upsertRatingRow({
    employeeId: employee.id,
    raterId,
    raterType,
    period,
    departmentId: employee.department_id,
    fieldEntries: entries,
    ...scores,
  });

  return shapeRow(row, config);
};

const upsertSelfRatingService = async (userId, employeeId, period, data) => {
  if (Number(userId) !== Number(employeeId)) {
    throw new ApiError(403, "You can only submit your own self-rating.");
  }

  const employee = await findUserWithManager(employeeId);
  if (!employee) throw new ApiError(404, "Employee not found.");

  return saveRating({
    raterType: "SELF",
    raterId: userId,
    employee,
    period,
    incoming: data.fieldEntries,
  });
};

const upsertSeniorRatingService = async (userId, userRole, employeeId, period, data) => {
  const employee = await findUserWithManager(employeeId);
  if (!employee) throw new ApiError(404, "Employee not found.");

  if (Number(userId) === Number(employeeId)) {
    throw new ApiError(403, "You cannot submit the senior rating for yourself.");
  }

  const role = normalizeRole(userRole);
  const isDirectManager = Number(employee.manager_id) === Number(userId);

  if (!isDirectManager && !isTopLevel(role)) {
    throw new ApiError(403, "Only this person's direct senior (or an admin) can submit this rating.");
  }

  return saveRating({
    raterType: "SENIOR",
    raterId: userId,
    employee,
    period,
    incoming: data.fieldEntries,
  });
};

/* ------------------------------------------------------------------ */
/* Senior edits the field list for one employee                        */
/* ------------------------------------------------------------------ */

const newKey = () => `f_${crypto.randomBytes(4).toString("hex")}`;

const updateEmployeeFieldsService = async (userId, userRole, employeeId, input) => {
  const employee = await findUserWithManager(employeeId);
  if (!employee) throw new ApiError(404, "Employee not found.");

  if (Number(userId) === Number(employeeId)) {
    throw new ApiError(403, "You cannot change the rating fields for yourself.");
  }

  const role = normalizeRole(userRole);
  const isDirectManager = Number(employee.manager_id) === Number(userId);
  if (!isDirectManager && !isTopLevel(role)) {
    throw new ApiError(403, "Only this person's direct senior (or an admin) can change their rating fields.");
  }

  const seen = new Set();
  const defs = [];

  for (const module of MODULES) {
    input[module].forEach((f, index) => {
      const key = f.key ?? newKey();
      if (seen.has(key)) throw new ApiError(400, "Duplicate field key in the field list.");
      seen.add(key);

      defs.push({
        employeeId: Number(employeeId),
        module,
        key,
        label: f.label,
        isNumeric: Boolean(f.isNumeric),
        sortOrder: index,
        createdById: Number(userId),
      });
    });
  }

  if (defs.length === 0) throw new ApiError(400, "Add at least one field.");

  await replaceFieldDefs(employeeId, defs);

  const dept = await getDepartmentById(employee.department_id);
  const saved = await getFieldDefsForEmployees([employeeId]);
  return buildFieldConfig(saved, deptName(dept));
};

module.exports = {
  getDepartmentsService,
  getFilterOptionsService,
  getFieldConfigService,
  getEmployeeRatingService,
  getTeamRatingService,
  upsertSelfRatingService,
  upsertSeniorRatingService,
  updateEmployeeFieldsService,
  RATING_BANDS,
  getBand,
};
