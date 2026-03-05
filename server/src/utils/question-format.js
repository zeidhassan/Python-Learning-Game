function normalizeQuestionRow(row) {
  return {
    id: row.id,
    concept: row.concept,
    prompt: row.prompt,
    questionType: row.question_type,
    difficulty: row.difficulty,
    explanation: row.explanation,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupQuestions(rows) {
  const map = new Map();

  for (const row of rows) {
    let question = map.get(row.id);

    if (!question) {
      question = {
        ...normalizeQuestionRow(row),
        options: [],
      };
      map.set(row.id, question);
    }

    if (row.option_id) {
      question.options.push({
        id: row.option_id,
        optionText: row.option_text,
        isCorrect: row.option_is_correct,
        position: row.option_position,
      });
    }
  }

  for (const question of map.values()) {
    question.options.sort((a, b) => a.position - b.position);
  }

  return Array.from(map.values());
}

module.exports = {
  groupQuestions,
};

