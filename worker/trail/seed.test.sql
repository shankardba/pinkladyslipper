-- TEST ONLY: placeholder spots so the test Worker has something to show.
-- Real spots are added from the admin page.
INSERT INTO spots (token, name) VALUES
  (lower(hex(randomblob(5))), 'The Coffee Shop'),
  (lower(hex(randomblob(5))), 'The Record Store'),
  (lower(hex(randomblob(5))), 'The Dive Bar'),
  (lower(hex(randomblob(5))), 'The Park Bench'),
  (lower(hex(randomblob(5))), 'The Late-Night Diner'),
  (lower(hex(randomblob(5))), 'The Practice Space');
