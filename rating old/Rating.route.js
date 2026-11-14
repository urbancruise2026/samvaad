const router = require("express").Router();

const auth = require("../../middlewares/auth.middleware");

const {
  getDepartments,
  getFilterOptions,
  getFieldConfig,
  getEmployeeRating,
  getMyRating,
  getTeamRating,
  submitSelfRating,
  submitSeniorRating,
  updateEmployeeFields,
} = require("./Rating.controller");

router.use(auth);

router.get("/departments", getDepartments);
router.get("/filters", getFilterOptions);
router.get("/field-config", getFieldConfig);

router.get("/me", getMyRating);
router.get("/team", getTeamRating);

router.get("/:employeeId", getEmployeeRating);
router.put("/:employeeId/self", submitSelfRating);
router.put("/:employeeId/senior", submitSeniorRating);
router.put("/:employeeId/fields", updateEmployeeFields);

module.exports = router;
