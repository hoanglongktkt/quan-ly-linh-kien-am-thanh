import { Router } from "express";
import {
  listExpenses,
  createExpense,
  deleteExpense,
  clearAllExpenses,
} from "../controllers/expensesController.js";

const router = Router();

router.get("/", listExpenses);
router.post("/", createExpense);
router.post("/clear-all", clearAllExpenses);
router.delete("/:id", deleteExpense);

export default router;
export { router };
