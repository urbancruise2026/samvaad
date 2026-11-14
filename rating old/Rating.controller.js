const asyncHandler = require("../../utils/asyncHandler");
const ApiResponse = require("../../utils/ApiResponse");
const ApiError = require("../../utils/ApiError");

const {
  getDepartmentsService,
  getFilterOptionsService,
  getFieldConfigService,
  getEmployeeRatingService,
  getTeamRatingService,
  upsertSelfRatingService,
  upsertSeniorRatingService,
  updateEmployeeFieldsService,
} = require("./Rating.service");

const {
  periodSchema,
  ratingSubmissionSchema,
  fieldConfigSchema,
  parse,
} = require("./Rating.validation");

const currentPeriod = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

const resolvePeriod = (raw) => parse(periodSchema, raw || currentPeriod());

// YYYY-MM strings compare correctly as plain strings.
const assertNotFuture = (period) => {
  if (period > currentPeriod()) {
    throw new ApiError(400, "You cannot submit a rating for a future period.");
  }
};

const getDepartments = asyncHandler(async (req, res) => {
  const departments = await getDepartmentsService();
  return res.status(200).json(new ApiResponse(200, departments, "Departments fetched successfully"));
});

const getFilterOptions = asyncHandler(async (req, res) => {
  const options = await getFilterOptionsService(req.user.id, req.user.role, req.query.departmentId);
  return res.status(200).json(new ApiResponse(200, options, "Filter options fetched successfully"));
});

const getFieldConfig = asyncHandler(async (req, res) => {
  const config = await getFieldConfigService(req.query.departmentId);
  return res.status(200).json(new ApiResponse(200, config, "Field config fetched successfully"));
});

const getEmployeeRating = asyncHandler(async (req, res) => {
  if (!/^\d+$/.test(req.params.employeeId)) throw new ApiError(400, "Invalid employee id.");
  const period = resolvePeriod(req.query.period);
  const rating = await getEmployeeRatingService(req.user.id, req.user.role, req.params.employeeId, period);
  return res.status(200).json(new ApiResponse(200, rating, "Rating fetched successfully"));
});

const getMyRating = asyncHandler(async (req, res) => {
  const period = resolvePeriod(req.query.period);
  const rating = await getEmployeeRatingService(req.user.id, req.user.role, req.user.id, period);
  return res.status(200).json(new ApiResponse(200, rating, "Rating fetched successfully"));
});

const getTeamRating = asyncHandler(async (req, res) => {
  const period = resolvePeriod(req.query.period);
  const { department, subDepartment } = req.query;
  const team = await getTeamRatingService(req.user.id, req.user.role, { department, subDepartment, period });
  return res.status(200).json(new ApiResponse(200, team, "Team ratings fetched successfully"));
});

const submitSelfRating = asyncHandler(async (req, res) => {
  const body = parse(ratingSubmissionSchema, req.body);
  const period = resolvePeriod(body.period);
  assertNotFuture(period);

  const row = await upsertSelfRatingService(req.user.id, req.params.employeeId, period, body);
  return res.status(200).json(new ApiResponse(200, row, "Self rating saved successfully"));
});

const submitSeniorRating = asyncHandler(async (req, res) => {
  const body = parse(ratingSubmissionSchema, req.body);
  const period = resolvePeriod(body.period);
  assertNotFuture(period);

  const row = await upsertSeniorRatingService(req.user.id, req.user.role, req.params.employeeId, period, body);
  return res.status(200).json(new ApiResponse(200, row, "Senior rating saved successfully"));
});

const updateEmployeeFields = asyncHandler(async (req, res) => {
  const config = parse(fieldConfigSchema, req.body);
  const fields = await updateEmployeeFieldsService(req.user.id, req.user.role, req.params.employeeId, config);
  return res.status(200).json(new ApiResponse(200, fields, "Rating fields saved successfully"));
});

module.exports = {
  getDepartments,
  getFilterOptions,
  getFieldConfig,
  getEmployeeRating,
  getMyRating,
  getTeamRating,
  submitSelfRating,
  submitSeniorRating,
  updateEmployeeFields,
};
