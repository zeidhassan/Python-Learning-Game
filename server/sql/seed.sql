BEGIN;

TRUNCATE TABLE attempts, room_players, game_rooms, board_tiles, question_options, questions, users RESTART IDENTITY CASCADE;

INSERT INTO users (email, password_hash, display_name, role)
VALUES
  (
    'admin@functionquest.local',
    '$2b$10$ptyxcumxjolWuEFbsBR7zu0WH8/2/ASaxKTeaGxEncjq4ONSGTz4i',
    'Game Admin',
    'admin'
  ),
  (
    'alice@example.com',
    '$2b$10$ptyxcumxjolWuEFbsBR7zu0WH8/2/ASaxKTeaGxEncjq4ONSGTz4i',
    'Alice',
    'player'
  ),
  (
    'bob@example.com',
    '$2b$10$ptyxcumxjolWuEFbsBR7zu0WH8/2/ASaxKTeaGxEncjq4ONSGTz4i',
    'Bob',
    'player'
  );

INSERT INTO questions (prompt, difficulty, explanation, created_by)
VALUES
  (
    'Which Python keyword is used to define a function?',
    'easy',
    'Python functions are declared using the def keyword followed by the function name.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'What will this function return? def add(a, b): return a + b; add(2, 3)',
    'easy',
    'The function returns the sum of the two arguments, which is 5.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'What happens if you call a function without providing a required positional argument?',
    'easy',
    'Python raises a TypeError because the function call is missing a required argument.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'What is the purpose of a return statement in a Python function?',
    'easy',
    'return sends a value back to the caller and ends the function execution.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'In Python, what is a parameter?',
    'medium',
    'A parameter is a variable listed in the function definition that receives a value (argument) when called.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'What does this function return if no explicit return is written? def greet(name): print(name)',
    'medium',
    'Functions without an explicit return statement return None by default.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'Which function definition correctly sets a default parameter value?',
    'medium',
    'Default parameter values are assigned in the function definition using the equals sign.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'What is the output of: def square(x): return x * x; print(square(4))',
    'easy',
    'square(4) returns 16, which is printed.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'Why would you use a function in a program?',
    'medium',
    'Functions help reuse code, improve readability, and organize logic into smaller blocks.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  ),
  (
    'Which statement about function scope is correct?',
    'hard',
    'Variables created inside a function are local to that function unless declared global/nonlocal.',
    (SELECT id FROM users WHERE email = 'admin@functionquest.local')
  );

INSERT INTO question_options (question_id, option_text, is_correct, position)
SELECT id, option_text, is_correct, position
FROM (
  VALUES
    ('Which Python keyword is used to define a function?', 'func', FALSE, 1),
    ('Which Python keyword is used to define a function?', 'def', TRUE, 2),
    ('Which Python keyword is used to define a function?', 'function', FALSE, 3),
    ('Which Python keyword is used to define a function?', 'define', FALSE, 4),

    ('What will this function return? def add(a, b): return a + b; add(2, 3)', '23', FALSE, 1),
    ('What will this function return? def add(a, b): return a + b; add(2, 3)', '5', TRUE, 2),
    ('What will this function return? def add(a, b): return a + b; add(2, 3)', 'Error', FALSE, 3),
    ('What will this function return? def add(a, b): return a + b; add(2, 3)', 'None', FALSE, 4),

    ('What happens if you call a function without providing a required positional argument?', 'Python ignores the missing argument', FALSE, 1),
    ('What happens if you call a function without providing a required positional argument?', 'Python uses zero automatically', FALSE, 2),
    ('What happens if you call a function without providing a required positional argument?', 'Python raises a TypeError', TRUE, 3),
    ('What happens if you call a function without providing a required positional argument?', 'Python returns None', FALSE, 4),

    ('What is the purpose of a return statement in a Python function?', 'To print a value on the screen', FALSE, 1),
    ('What is the purpose of a return statement in a Python function?', 'To send a value back to the caller', TRUE, 2),
    ('What is the purpose of a return statement in a Python function?', 'To repeat the function', FALSE, 3),
    ('What is the purpose of a return statement in a Python function?', 'To create a variable outside the function', FALSE, 4),

    ('In Python, what is a parameter?', 'A value passed into a function call only', FALSE, 1),
    ('In Python, what is a parameter?', 'A variable in the function definition', TRUE, 2),
    ('In Python, what is a parameter?', 'A module imported into Python', FALSE, 3),
    ('In Python, what is a parameter?', 'The result returned by a function', FALSE, 4),

    ('What does this function return if no explicit return is written? def greet(name): print(name)', 'An empty string', FALSE, 1),
    ('What does this function return if no explicit return is written? def greet(name): print(name)', '0', FALSE, 2),
    ('What does this function return if no explicit return is written? def greet(name): print(name)', 'None', TRUE, 3),
    ('What does this function return if no explicit return is written? def greet(name): print(name)', 'The printed name', FALSE, 4),

    ('Which function definition correctly sets a default parameter value?', 'def greet(name == ''Guest''):', FALSE, 1),
    ('Which function definition correctly sets a default parameter value?', 'def greet(name = ''Guest''):', TRUE, 2),
    ('Which function definition correctly sets a default parameter value?', 'function greet(name=''Guest'')', FALSE, 3),
    ('Which function definition correctly sets a default parameter value?', 'def greet(name: ''Guest'')', FALSE, 4),

    ('What is the output of: def square(x): return x * x; print(square(4))', '8', FALSE, 1),
    ('What is the output of: def square(x): return x * x; print(square(4))', '16', TRUE, 2),
    ('What is the output of: def square(x): return x * x; print(square(4))', '4', FALSE, 3),
    ('What is the output of: def square(x): return x * x; print(square(4))', 'square', FALSE, 4),

    ('Why would you use a function in a program?', 'To make code longer', FALSE, 1),
    ('Why would you use a function in a program?', 'To avoid using variables', FALSE, 2),
    ('Why would you use a function in a program?', 'To reuse and organize code', TRUE, 3),
    ('Why would you use a function in a program?', 'To replace all loops', FALSE, 4),

    ('Which statement about function scope is correct?', 'Variables inside a function are always global', FALSE, 1),
    ('Which statement about function scope is correct?', 'Variables inside a function are local by default', TRUE, 2),
    ('Which statement about function scope is correct?', 'Python does not support local variables in functions', FALSE, 3),
    ('Which statement about function scope is correct?', 'Function scope only exists in JavaScript', FALSE, 4)
) AS seed(prompt, option_text, is_correct, position)
JOIN questions q ON q.prompt = seed.prompt;

INSERT INTO board_tiles (tile_number, question_id, qr_payload, is_active)
SELECT tile_number, q.id, qr_payload, TRUE
FROM (
  VALUES
    (1, 'Which Python keyword is used to define a function?', 'FQ-TILE-01'),
    (2, 'What will this function return? def add(a, b): return a + b; add(2, 3)', 'FQ-TILE-02'),
    (3, 'What happens if you call a function without providing a required positional argument?', 'FQ-TILE-03'),
    (4, 'What is the purpose of a return statement in a Python function?', 'FQ-TILE-04'),
    (5, 'In Python, what is a parameter?', 'FQ-TILE-05'),
    (6, 'What does this function return if no explicit return is written? def greet(name): print(name)', 'FQ-TILE-06'),
    (7, 'Which function definition correctly sets a default parameter value?', 'FQ-TILE-07'),
    (8, 'What is the output of: def square(x): return x * x; print(square(4))', 'FQ-TILE-08'),
    (9, 'Why would you use a function in a program?', 'FQ-TILE-09'),
    (10, 'Which statement about function scope is correct?', 'FQ-TILE-10')
) AS tile_map(tile_number, prompt, qr_payload)
JOIN questions q ON q.prompt = tile_map.prompt;

COMMIT;
