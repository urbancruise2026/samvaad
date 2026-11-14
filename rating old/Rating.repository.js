const { mysqlDb, postgresDb } = require("../../config/db");

const formatName = (u) => `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();

const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  access_role: true,
  department_id: true,
  subDepartment_id: true,
  manager_id: true,
  is_active: true,
};

/* ------------------------------------------------------------------ */
/* Departments (MySQL)                                                 */
/* ------------------------------------------------------------------ */

const getAllDepartments = async () => {
  return mysqlDb.departments.findMany({
    select: { id: true, department_name: true },
    orderBy: { department_name: "asc" },
  });
};

const getDepartmentById = async (departmentId) => {
  if (!departmentId) return null;
  return mysqlDb.departments.findUnique({
    where: { id: Number(departmentId) },
    select: { id: true, department_name: true },
  });
};

// One query for many ids (avoids N+1). Returns Map<id, department>.
const getDepartmentsByIds = async (departmentIds) => {
  const uniqueIds = [...new Set(departmentIds.filter(Boolean).map(Number))];
  if (uniqueIds.length === 0) return new Map();

  const departments = await mysqlDb.departments.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, department_name: true },
  });

  return new Map(departments.map((d) => [d.id, d]));
};

/* ------------------------------------------------------------------ */
/* Sub-departments (MySQL: access_control.subdepartment_id)            */
/*                                                                     */
/* ASSUMPTION: the `sub_department` table's name column is not known   */
/* to this module. We try the common spellings below. If yours is      */
/* different, add it to subDeptName() - that is the only place.        */
/* Likewise `department_id` is used (if present) to link a             */
/* sub-department to its parent department for the cascading filter.   */
/* ------------------------------------------------------------------ */

const subDeptName = (sd) =>
  sd?.subDepartment_name ??
  sd?.sub_department_name ??
  sd?.subdepartment_name ??
  sd?.name ??
  null;

const isActive = (r) => r.is_active !== false && r.is_active !== 0;

const toSubDept = (r) => ({
  id: r.id,
  name: subDeptName(r),
  departmentId: r.department_id ?? null,
});

const byName = (a, b) => (a.name ?? "").localeCompare(b.name ?? "");

// Active sub-departments of ONE department.
const getSubDepartmentsByDepartment = async (departmentId) => {
  if (!departmentId) return [];
  const rows = await mysqlDb.sub_department.findMany({
    where: { department_id: Number(departmentId) },
  });
  return rows.filter(isActive).map(toSubDept).sort(byName);
};

// Active sub-departments from a list of ids (used for a manager's team).
const getSubDepartmentsByIds = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(Number))];
  if (unique.length === 0) return [];
  const rows = await mysqlDb.sub_department.findMany({
    where: { id: { in: unique } },
  });
  return rows.filter(isActive).map(toSubDept).sort(byName);
};

// Map<employeeId, { id, name }> - first access_control row with a sub-department wins.
const getSubDepartmentMap = async (employeeIds) => {
  const ids = [...new Set(employeeIds.filter(Boolean).map(Number))];
  if (ids.length === 0) return new Map();

  const users = await mysqlDb.uc_staff.findMany({
    where: { id: { in: ids }, subDepartment_id: { not: null } },
    select: { id: true, subDepartment_id: true },
  });
  if (users.length === 0) return new Map();

  const subs = await mysqlDb.sub_department.findMany({
    where: { id: { in: [...new Set(users.map((u) => u.subDepartment_id))] } },
  });
  const byId = new Map(subs.map((s) => [s.id, s]));

  const map = new Map();
  for (const u of users) {
    map.set(u.id, {
      id: u.subDepartment_id,
      name: subDeptName(byId.get(u.subDepartment_id)),
    });
  }
  return map;
};

const getEmployeeIdsBySubDepartment = async (subDepartmentId) => {
  const rows = await mysqlDb.access_control.findMany({
    where: { subdepartment_id: Number(subDepartmentId) },
    select: { employee_id: true },
  });
  return [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
};

/* ------------------------------------------------------------------ */
/* Users (MySQL)                                                       */
/* ------------------------------------------------------------------ */

const applySubDepartmentFilter = (where, subDepartmentFilter) => {
  if (subDepartmentFilter) where.subDepartment_id = Number(subDepartmentFilter);
};

// Direct reports only - matches the "Self + one direct senior" rule.
const getDirectReports = async (managerId, departmentFilter, subDepartmentFilter) => {
  const where = { manager_id: Number(managerId) };
  if (departmentFilter) where.department_id = Number(departmentFilter);
  await applySubDepartmentFilter(where, subDepartmentFilter);

  return mysqlDb.uc_staff.findMany({
    where,
    select: USER_SELECT,
    orderBy: { firstName: "asc" },
  });
};

// Org-wide, for top-level roles.
const getAllUsersForRating = async (departmentFilter, subDepartmentFilter) => {
  const where = {};
  if (departmentFilter) where.department_id = Number(departmentFilter);
  await applySubDepartmentFilter(where, subDepartmentFilter);

  return mysqlDb.uc_staff.findMany({
    where,
    select: USER_SELECT,
    orderBy: { firstName: "asc" },
  });
};

const findUserWithManager = async (userId) => {
  return mysqlDb.users.findUnique({
    where: { id: Number(userId) },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      access_role: true,
      department_id: true,
      manager_id: true,
    },
  });
};

/* ------------------------------------------------------------------ */
/* Ratings (Postgres)                                                  */
/* ------------------------------------------------------------------ */

const getRatingRows = async (employeeId, period) => {
  return postgresDb.rating.findMany({
    where: { employeeId: Number(employeeId), period },
  });
};

const getRatingRowsForTeam = async (employeeIds, period) => {
  return postgresDb.rating.findMany({
    where: { employeeId: { in: employeeIds }, period },
  });
};

const upsertRatingRow = async ({
  employeeId,
  raterId,
  raterType,
  period,
  departmentId,
  salesScore,
  conductScore,
  contributionScore,
  achievementPercent,
  fieldEntries,
}) => {
  const data = {
    raterId: Number(raterId),
    departmentId: departmentId ? Number(departmentId) : null,
    salesScore,
    conductScore,
    contributionScore,
    achievementPercent,
    fieldEntries,
  };

  return postgresDb.rating.upsert({
    where: {
      employeeId_raterType_period: {
        employeeId: Number(employeeId),
        raterType,
        period,
      },
    },
    update: data,
    create: {
      employeeId: Number(employeeId),
      raterType,
      period,
      ...data,
    },
  });
};

/* ------------------------------------------------------------------ */
/* Per-employee field definitions (Postgres)                           */
/* ------------------------------------------------------------------ */

const getFieldDefsForEmployees = async (employeeIds) => {
  const ids = [...new Set(employeeIds.filter(Boolean).map(Number))];
  if (ids.length === 0) return [];

  return postgresDb.ratingFieldDef.findMany({
    where: { employeeId: { in: ids } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
};

// Replaces the employee's whole field list in one transaction.
const replaceFieldDefs = async (employeeId, defs) => {
  return postgresDb.$transaction([
    postgresDb.ratingFieldDef.deleteMany({ where: { employeeId: Number(employeeId) } }),
    postgresDb.ratingFieldDef.createMany({ data: defs }),
  ]);
};

module.exports = {
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
};getEmployeeIdsBySubDepartment
