"""K12Plus offline lesson packs (pilot item 12).

Builds lessons/<id>.json and lessons/index.json. Every practice answer is computed
or checked here with exact arithmetic or SymPy before it is written, so a typing
slip in an answer stops the build instead of reaching learners.

Packs are DRAFTS until a teacher has checked them: learners only see a pack after
a teacher or K-12 EdTech administrator marks it as checked in the app. Changing a
pack's content means raising its version, which sends it back for checking.

Run: python3 curriculum-src/lesson_packs.py
"""
import gzip
import json
import math
import os
from fractions import Fraction as F

import sympy as sp

OUT = os.path.join(os.path.dirname(__file__), '..', 'lessons')
x, k = sp.symbols('x k')


def sig(v, n=3):
    """v rounded to n significant figures, as text (e.g. 2.82, 0.549, 746)."""
    if v == 0:
        return '0'
    d = n - int(math.floor(math.log10(abs(v)))) - 1
    r = round(v, d)
    return (f'{r:.{max(d, 0)}f}') if d > 0 else str(int(round(r)))


def num(q, answer, hint, solution, accept=(), level=1):
    return {'type': 'number', 'q': q, 'answer': str(answer), 'accept': [str(a) for a in accept], 'hint': hint, 'solution': solution, 'level': level}


def choice(q, options, answer, hint, solution, level=1):
    assert answer in 'ABCD'[:len(options)]
    return {'type': 'choice', 'q': q, 'options': options, 'answer': answer, 'hint': hint, 'solution': solution, 'level': level}


def same(a, b):
    return sp.simplify(sp.sympify(a) - sp.sympify(b)) == 0


def solve1(eq):
    s = sp.solve(eq, x)
    assert len(s) == 1, s
    return s[0]


packs = []

# ---------------------------------------------------------------- Grade 11: equations
items = []
assert solve1(sp.Eq(x + 7, 15)) == 8
items.append(num('Solve x + 7 = 15.', 8, 'Take 7 away from both sides.', 'x + 7 = 15, so x = 15 − 7 = 8.'))
assert solve1(sp.Eq(3 * x - 4, 17)) == 7
items.append(num('Solve 3x − 4 = 17.', 7, 'First add 4 to both sides, then divide by 3.', '3x − 4 = 17, so 3x = 21 and x = 7.'))
assert solve1(sp.Eq(4 - 3 * x, 19)) == -5
items.append(num('Solve 4 − 3x = 19.', -5, 'Take 4 from both sides. Watch the negative sign when you divide.', '4 − 3x = 19, so −3x = 15 and x = 15 ÷ (−3) = −5.'))
assert solve1(sp.Eq(7 * x - 5, 3 * x + 15)) == 5
items.append(num('Solve 7x − 5 = 3x + 15.', 5, 'Collect the x terms on the left and the numbers on the right.', '7x − 3x = 15 + 5, so 4x = 20 and x = 5.', level=2))
assert solve1(sp.Eq(5 * (x - 1), 2 * (x + 8))) == 7
items.append(num('Solve 5(x − 1) = 2(x + 8).', 7, 'Expand both brackets first.', '5x − 5 = 2x + 16, so 3x = 21 and x = 7.', level=2))
assert solve1(sp.Eq(x / 4 + 3, 8)) == 20
items.append(num('Solve x/4 + 3 = 8.', 20, 'Take 3 from both sides, then multiply by 4.', 'x/4 = 5, so x = 20.', level=2))
assert solve1(sp.Eq((x + 2) / 3, (x - 1) / 2)) == 7
items.append(num('Solve (x + 2)/3 = (x − 1)/2.', 7, 'Multiply both sides by 6, the lowest common multiple of 3 and 2.', '2(x + 2) = 3(x − 1), so 2x + 4 = 3x − 3 and x = 7.', level=3))
a_, b_ = sp.symbols('a b')
s = sp.solve([3 * a_ + b_ - 14, a_ + b_ - 6], [a_, b_])
assert s == {a_: 4, b_: 2}
items.append(num('Solve the simultaneous equations 3x + y = 14 and x + y = 6. What is x?', 4, 'Subtract the second equation from the first: the y terms disappear.', '(3x + y) − (x + y) = 14 − 6, so 2x = 8 and x = 4 (then y = 2).', level=2))
s = sp.solve([2 * a_ + 3 * b_ - 19, 4 * a_ - 3 * b_ - 11], [a_, b_])
assert s == {a_: 5, b_: 3}
items.append(num('Solve the simultaneous equations 2x + 3y = 19 and 4x − 3y = 11. What is y?', 3, 'Add the equations to remove y, find x, then put x back into one equation.', 'Adding gives 6x = 30, so x = 5. Then 2(5) + 3y = 19, so 3y = 9 and y = 3.', level=3))
assert solve1(sp.Eq(12 + 3 * x, 39)) == 9
items.append(num('A taxi in Oshakati charges N$ 12 to start plus N$ 3 for every kilometre. A trip costs N$ 39. How many kilometres was the trip?', 9, 'Write an equation: 12 + 3x = 39.', '12 + 3x = 39, so 3x = 27 and x = 9 km.', level=2))
# inequality 3x − 2 < 13  ->  x < 5
assert sp.solve_univariate_inequality(3 * x - 2 < 13, x, relational=False) == sp.Interval.open(-sp.oo, 5)
items.append(choice('Solve the inequality 3x − 2 < 13.', ['x < 5', 'x > 5', 'x < 11/3', 'x < 15'], 'A', 'Solve it like an equation: add 2, then divide by 3. Dividing by a positive number keeps the sign the same.', '3x < 15, so x < 5.', level=2))
assert set(sp.solve(x**2 - 5 * x + 6, x)) == {2, 3}
items.append(choice('Solve x² − 5x + 6 = 0.', ['x = 2 or x = 3', 'x = −2 or x = −3', 'x = 1 or x = 6', 'x = −1 or x = 6'], 'A', 'Find two numbers that multiply to 6 and add to −5.', '(x − 2)(x − 3) = 0, so x = 2 or x = 3.', level=3))
packs.append({
    'id': 'g11-equations', 'version': 1, 'grade': 11, 'subject': 'Mathematics', 'syllabus': '6131',
    'topic': 'Algebra / Equations and inequalities', 'title': 'Solving equations', 'minutes': 25,
    'explanation': [
        'An equation says that two things are equal, for example 3x − 4 = 17. Solving it means finding the value of x that makes both sides equal.',
        'Think of a balance scale. Whatever you do to one side, you must do to the other side too, and the scale stays level. You may add, subtract, multiply or divide both sides by the same number (but never divide by 0).',
        'A good order of work: expand any brackets, clear fractions by multiplying both sides by the lowest common multiple of the denominators, move the x terms to one side and the numbers to the other, then divide by the number in front of x.',
        'Simultaneous equations are two equations with two unknowns. Add or subtract them so that one unknown disappears (elimination), or make one unknown the subject and put it into the other equation (substitution).',
        'An inequality such as 3x − 2 < 13 is solved the same way, with one extra rule: if you multiply or divide both sides by a negative number, the inequality sign turns around.',
        'For a quadratic equation, move everything to one side so it equals 0, factorise, and set each bracket equal to 0.',
        'Always check your answer by putting it back into the original equation.',
    ],
    'keyPoints': ['Do the same to both sides.', 'Expand brackets and clear fractions first.', 'Dividing an inequality by a negative number turns the sign around.', 'Check by substituting your answer.'],
    'examples': [
        {'q': 'Solve 4(x − 3) = 2x + 6.', 'steps': ['Expand the bracket: 4x − 12 = 2x + 6.', 'Take 2x from both sides: 2x − 12 = 6.', 'Add 12 to both sides: 2x = 18.', 'Divide by 2: x = 9.', 'Check: 4(9 − 3) = 24 and 2(9) + 6 = 24.'], 'answer': 'x = 9'},
        {'q': 'Two pies and a cooldrink cost N$ 46. One pie and a cooldrink cost N$ 28. Find the price of a pie.', 'steps': ['Let p be the price of a pie and c the price of a cooldrink.', '2p + c = 46 and p + c = 28.', 'Subtract the second equation from the first: p = 18.', 'Then c = 28 − 18 = 10.'], 'answer': 'A pie costs N$ 18.'},
    ],
    'practice': items,
})
assert 4 * (9 - 3) == 2 * 9 + 6 and 2 * 18 + 10 == 46 and 18 + 10 == 28

# ---------------------------------------------------------------- Grade 11: percentages and money
items = []
assert F(20, 100) * 450 == 90
items.append(num('Work out 20% of N$ 450.', 90, '20% means 20/100. Multiply 450 by 0.2.', '0.2 × 450 = N$ 90.'))
assert F(35, 50) * 100 == 70
items.append(num('A learner scores 35 out of 50 in a test. What is this as a percentage?', 70, 'Divide the score by the total, then multiply by 100.', '35 ÷ 50 × 100 = 70%.'))
assert F(3, 8) * 100 == F(75, 2)
items.append(num('Write 3/8 as a percentage.', 37.5, 'Divide 3 by 8, then multiply by 100.', '3 ÷ 8 = 0.375, and 0.375 × 100 = 37.5%.'))
assert 80 * F(125, 100) == 100
items.append(num('Increase N$ 80 by 25%.', 100, 'An increase of 25% means multiplying by 1.25.', '80 × 1.25 = N$ 100.'))
assert 640 * F(85, 100) == 544
items.append(num('Decrease N$ 640 by 15%.', 544, 'A decrease of 15% leaves 85%. Multiply by 0.85.', '640 × 0.85 = N$ 544.', level=2))
items.append(choice('Which number do you multiply by to decrease an amount by 12%?', ['0.12', '0.88', '1.12', '0.012'], 'B', 'After a decrease of 12%, what percentage is left?', '100% − 12% = 88%, so multiply by 0.88.'))
assert 360 * F(115, 100) == 414
items.append(num('A pair of school shoes costs N$ 360 before VAT. VAT of 15% is added. What is the price with VAT, in N$?', 414, 'With VAT the price is 115% of the price before VAT.', '360 × 1.15 = N$ 414.', level=2))
assert F(290 - 250, 250) * 100 == 16
items.append(num('The price of a bag of maize meal rises from N$ 250 to N$ 290. What is the percentage increase?', 16, 'Percentage change = change ÷ original × 100.', 'Change = 40. 40 ÷ 250 × 100 = 16%.', level=2))
assert F(1200 - 900, 1200) * 100 == 25
items.append(num('A second-hand bicycle loses value from N$ 1 200 to N$ 900. What is the percentage decrease?', 25, 'Divide the decrease by the ORIGINAL value.', 'Decrease = 300. 300 ÷ 1 200 × 100 = 25%.', level=2))
assert F(560) / F(80, 100) == 700
items.append(num('After a 20% discount a radio costs N$ 560. What was the price before the discount, in N$?', 700, 'N$ 560 is 80% of the original price. Divide by 0.8.', '560 ÷ 0.8 = N$ 700.', level=3))
assert F(230) / F(115, 100) == 200
items.append(num('A meal costs N$ 230 including 15% VAT. What was the price before VAT, in N$?', 200, 'N$ 230 is 115% of the price before VAT. Divide by 1.15.', '230 ÷ 1.15 = N$ 200.', level=3))
assert 2000 * 6 * 3 / F(100) == 360
items.append(num('Find the simple interest on N$ 2 000 at 6% per year for 3 years, in N$.', 360, 'Simple interest = P × R × T ÷ 100.', '2 000 × 6 × 3 ÷ 100 = N$ 360.', level=2))
assert 5000 * F(108, 100) ** 2 == 5832
items.append(num('N$ 5 000 is saved at 8% per year compound interest. How much is in the account after 2 years, in N$?', 5832, 'Multiply by 1.08 once for each year.', '5 000 × 1.08 × 1.08 = N$ 5 832.', level=3))
packs.append({
    'id': 'g11-percentages', 'version': 1, 'grade': 11, 'subject': 'Mathematics', 'syllabus': '6131',
    'topic': 'Numbers and operations / Vulgar and decimal fractions and percentages', 'title': 'Percentages and money', 'minutes': 25,
    'explanation': [
        'Per cent means "out of 100". So 15% is 15/100, which is 0.15.',
        'To find a percentage of an amount, change the percentage to a decimal and multiply: 20% of N$ 450 is 0.2 × 450 = N$ 90.',
        'To write one number as a percentage of another, divide and multiply by 100: 35 out of 50 is 35 ÷ 50 × 100 = 70%.',
        'The multiplier method is the quickest way to increase or decrease. An increase of 15% means you now have 115%, so multiply by 1.15. A decrease of 15% leaves 85%, so multiply by 0.85.',
        'Percentage increase or decrease = change ÷ original amount × 100. Always divide by the original amount, not the new one.',
        'In Namibia VAT is 15%, so a price with VAT is the price before VAT × 1.15. To go backwards (reverse percentage), divide by the multiplier: a price of N$ 345 with VAT was 345 ÷ 1.15 = N$ 300 before VAT.',
        'Simple interest is the same every year: I = P × R × T ÷ 100. Compound interest earns interest on the interest too: amount = P × (1 + R/100)ⁿ after n years.',
    ],
    'keyPoints': ['Increase by r%: multiply by (1 + r/100).', 'Decrease by r%: multiply by (1 − r/100).', 'Reverse percentage: divide by the multiplier.', 'Percentage change uses the original amount.'],
    'examples': [
        {'q': 'The price of a school jersey rises from N$ 150 to N$ 180. Find the percentage increase.', 'steps': ['Change = 180 − 150 = N$ 30.', 'Percentage increase = 30 ÷ 150 × 100.', '= 20%.'], 'answer': '20%'},
        {'q': 'A blanket costs N$ 345 including 15% VAT. Find the price before VAT.', 'steps': ['N$ 345 is 115% of the price before VAT.', 'Price before VAT = 345 ÷ 1.15.', '= N$ 300.', 'Check: 300 × 1.15 = 345.'], 'answer': 'N$ 300'},
    ],
    'practice': items,
})
assert F(30, 150) * 100 == 20 and F(345) / F(115, 100) == 300

# ---------------------------------------------------------------- Grade 11: expanding and factorising
items = []
assert sp.expand(3 * (2 * x + 5)) == 6 * x + 15
items.append(choice('Expand 3(2x + 5).', ['6x + 5', '6x + 15', '5x + 15', '6x + 8'], 'B', 'Multiply BOTH terms inside the bracket by 3.', '3 × 2x = 6x and 3 × 5 = 15, so 6x + 15.'))
assert same('5*(2*x + 3)', '10*x + 15')
items.append(choice('Factorise 10x + 15.', ['5(2x + 3)', '10(x + 15)', '5(2x + 15)', '2(5x + 7)'], 'A', 'What is the highest number that divides into both 10 and 15?', 'The highest common factor is 5: 10x + 15 = 5(2x + 3).'))
assert same('4*x*(2*x - 3)', '8*x**2 - 12*x')
items.append(choice('Factorise completely 8x² − 12x.', ['4(2x² − 3x)', 'x(8x − 12)', '4x(2x − 3)', '2x(4x − 6)'], 'C', 'Take out the highest common factor of the numbers AND the letters.', 'The highest common factor is 4x: 8x² − 12x = 4x(2x − 3).', level=2))
assert sp.factor(x**2 + 7 * x + 12) == (x + 3) * (x + 4)
items.append(num('x² + 7x + 12 = (x + 3)(x + p). Find p.', 4, 'You need a number that multiplies with 3 to give 12.', '3 × 4 = 12 and 3 + 4 = 7, so p = 4.', level=2))
assert sp.factor(x**2 - 2 * x - 15) == (x - 5) * (x + 3)
items.append(num('x² − 2x − 15 = (x − 5)(x + q). Find q.', 3, 'The two numbers must multiply to −15 and add to −2.', '−5 × 3 = −15 and −5 + 3 = −2, so q = 3.', level=2))
assert sp.factor(x**2 - 9 * x + 20) == (x - 5) * (x - 4)
items.append(num('x² − 9x + 20 = (x − a)(x − b), where a is smaller than b. Find b.', 5, 'Find two numbers that multiply to 20 and add to 9.', '4 × 5 = 20 and 4 + 5 = 9, so the factors are (x − 4)(x − 5) and b = 5.', level=2))
assert sp.factor(x**2 - 49) == (x - 7) * (x + 7)
items.append(choice('Factorise x² − 49.', ['(x − 7)²', '(x − 7)(x + 7)', 'x(x − 49)', '(x + 7)²'], 'B', 'This is a difference of two squares: a² − b² = (a − b)(a + b).', 'x² − 7² = (x − 7)(x + 7).', level=2))
assert sp.factor(4 * x**2 - 25) == (2 * x - 5) * (2 * x + 5)
items.append(choice('Factorise 4x² − 25.', ['(4x − 5)(x + 5)', '(2x − 5)²', '(2x − 5)(2x + 5)', '(2x − 25)(2x + 1)'], 'C', '4x² is (2x)² and 25 is 5².', '(2x)² − 5² = (2x − 5)(2x + 5).', level=2))
assert same('3*(x - 2)*(x + 2)', '3*x**2 - 12') and sp.factor_list(3 * x**2 - 12) == (3, [(x - 2, 1), (x + 2, 1)])
items.append(choice('Factorise completely 3x² − 12.', ['3(x² − 4)', '3(x − 2)(x + 2)', '(3x − 6)(x + 2)', '3(x − 2)²'], 'B', 'Take out the common factor 3 first, then look again at what is left.', '3x² − 12 = 3(x² − 4) = 3(x − 2)(x + 2).', level=3))
assert sp.factor(2 * x**2 + 7 * x + 3) == (2 * x + 1) * (x + 3)
items.append(num('2x² + 7x + 3 = (2x + 1)(x + m). Find m.', 3, 'Expand (2x + 1)(x + m) and compare it with 2x² + 7x + 3.', '(2x + 1)(x + 3) = 2x² + 6x + x + 3 = 2x² + 7x + 3, so m = 3.', level=3))
a_, b_, y_ = sp.symbols('a b y')
assert sp.expand((a_ + b_) * (x + y_)) == sp.expand(a_ * x + a_ * y_ + b_ * x + b_ * y_)
items.append(choice('Factorise ax + ay + bx + by.', ['(a + x)(b + y)', '(a + b)(x + y)', 'ab(x + y)', '(a + y)(b + x)'], 'B', 'Group the terms in pairs: a(x + y) + b(x + y).', 'a(x + y) + b(x + y) = (a + b)(x + y).', level=3))
assert 53**2 - 47**2 == 600
items.append(num('Use factorising to work out 53² − 47² without a calculator.', 600, 'a² − b² = (a − b)(a + b).', '(53 − 47)(53 + 47) = 6 × 100 = 600.', level=3))
assert sp.simplify((x**2 - 4) / (x + 2)) == x - 2
items.append(choice('Simplify (x² − 4)/(x + 2).', ['x − 2', 'x + 2', 'x − 4', 'x² − 2'], 'A', 'Factorise the top first.', '(x − 2)(x + 2)/(x + 2) = x − 2.', level=3))
packs.append({
    'id': 'g11-factorising', 'version': 1, 'grade': 11, 'subject': 'Mathematics', 'syllabus': '6131',
    'topic': 'Algebra / Algebraic manipulation', 'title': 'Expanding and factorising', 'minutes': 25,
    'explanation': [
        'Expanding removes brackets: 3(2x + 5) = 6x + 15. Factorising is the reverse: it puts brackets back in, so 6x + 15 = 3(2x + 5).',
        'Common factor: find the highest common factor of every term, numbers and letters, and take it outside the bracket. 8x² − 12x = 4x(2x − 3).',
        'Difference of two squares: a² − b² = (a − b)(a + b). For example x² − 49 = (x − 7)(x + 7) and 4x² − 25 = (2x − 5)(2x + 5).',
        'Quadratics x² + bx + c: find two numbers that multiply to c and add to b. For x² + 7x + 12, the numbers 3 and 4 work, so x² + 7x + 12 = (x + 3)(x + 4).',
        'When the x² term has a number in front, such as 2x² + 7x + 3, try pairs of brackets like (2x + ?)(x + ?) and expand to check.',
        'Four terms: group them in pairs and take out a common factor from each pair. ax + ay + bx + by = a(x + y) + b(x + y) = (a + b)(x + y).',
        '"Factorise completely" means keep going until no bracket can be factorised again. Always check by expanding your answer.',
    ],
    'keyPoints': ['Take out the highest common factor first.', 'a² − b² = (a − b)(a + b).', 'For x² + bx + c: two numbers that multiply to c and add to b.', 'Check by expanding.'],
    'examples': [
        {'q': 'Factorise completely 12x² − 8x.', 'steps': ['The highest common factor of 12x² and 8x is 4x.', '12x² ÷ 4x = 3x and 8x ÷ 4x = 2.', 'So 12x² − 8x = 4x(3x − 2).', 'Check: 4x × 3x − 4x × 2 = 12x² − 8x.'], 'answer': '4x(3x − 2)'},
        {'q': 'Factorise x² − x − 12.', 'steps': ['Find two numbers that multiply to −12 and add to −1.', '−4 and 3 work: −4 × 3 = −12 and −4 + 3 = −1.', 'So x² − x − 12 = (x − 4)(x + 3).'], 'answer': '(x − 4)(x + 3)'},
    ],
    'practice': items,
})
assert same('4*x*(3*x - 2)', '12*x**2 - 8*x') and sp.factor(x**2 - x - 12) == (x - 4) * (x + 3)

# ---------------------------------------------------------------- Grade 12: completing the square, discriminant
items = []
p_, q_ = 3, 2 - 9
assert sp.expand((x + p_)**2 + q_) == x**2 + 6 * x + 2
items.append(num('x² + 6x + 2 is written in the form (x + p)² + q. Find p.', 3, 'p is half of the number in front of x.', 'Half of 6 is 3, so p = 3.'))
items.append(num('x² + 6x + 2 is written in the form (x + p)² + q. Find q.', -7, '(x + 3)² = x² + 6x + 9. How much must you add to 9 to get 2?', 'x² + 6x + 2 = (x + 3)² − 9 + 2 = (x + 3)² − 7, so q = −7.'))
assert sp.expand((x - 5)**2 + 5) == x**2 - 10 * x + 30
items.append(num('Find the minimum value of y = x² − 10x + 30.', 5, 'Complete the square: (x − 5)² + q.', 'x² − 10x + 30 = (x − 5)² + 5. A square is never negative, so the minimum value is 5.', level=2))
assert sp.solve(sp.diff(x**2 + 4 * x - 1, x), x) == [-2]
items.append(num('Find the x-coordinate of the turning point of y = x² + 4x − 1.', -2, 'Write it as (x + 2)² + q. The turning point is where the bracket is 0.', 'x² + 4x − 1 = (x + 2)² − 5, so the turning point is at x = −2.', level=2))
assert sp.expand(2 * (x + 3)**2 - 11) == 2 * x**2 + 12 * x + 7
items.append(num('2x² + 12x + 7 is written in the form 2(x + 3)² + q. Find q.', -11, 'Expand 2(x + 3)² and compare the numbers.', '2(x + 3)² = 2x² + 12x + 18. Since 18 + q = 7, q = −11.', level=3))
assert 5**2 - 4 * 2 * (-3) == 49
items.append(num('Find the value of the discriminant b² − 4ac for 2x² + 5x − 3 = 0.', 49, 'Here a = 2, b = 5 and c = −3.', 'b² − 4ac = 25 − 4(2)(−3) = 25 + 24 = 49.', level=2))
assert (-4)**2 - 4 * 1 * 4 == 0
items.append(choice('How many real roots does x² − 4x + 4 = 0 have?', ['Two different real roots', 'One repeated (equal) root', 'No real roots', 'Three real roots'], 'B', 'Work out b² − 4ac.', 'b² − 4ac = 16 − 16 = 0, so there is one repeated root (x = 2).', level=2))
assert (-2)**2 - 4 * 3 * 1 < 0
items.append(choice('How many real roots does 3x² − 2x + 1 = 0 have?', ['Two different real roots', 'One repeated (equal) root', 'No real roots', 'Cannot tell'], 'C', 'Work out b² − 4ac.', 'b² − 4ac = 4 − 12 = −8, which is negative, so there are no real roots.', level=2))
assert sp.solve(k**2 - 64, k) == [-8, 8]
items.append(num('x² + kx + 16 = 0 has equal roots. Find the positive value of k.', 8, 'Equal roots means b² − 4ac = 0.', 'k² − 4(1)(16) = 0, so k² = 64 and k = 8 (or −8).', level=3))
kk = sp.solve(sp.Eq(9 - 4 * (1 - k), 0), k)[0]
assert kk == sp.Rational(-5, 4)
items.append(num('The line y = 3x + k is a tangent to the curve y = x² + 1. Find k.', '-1.25', 'Set x² + 1 = 3x + k, write it as a quadratic = 0, and use b² − 4ac = 0.', 'x² − 3x + (1 − k) = 0. For a tangent, 9 − 4(1 − k) = 0, so 4k = −5 and k = −1.25.', accept=['-5/4'], level=3))
assert sp.solve_univariate_inequality(x**2 - x - 6 < 0, x, relational=False) == sp.Interval.open(-2, 3)
items.append(choice('Solve x² − x − 6 < 0.', ['−2 < x < 3', 'x < −2 or x > 3', '−3 < x < 2', 'x < 3'], 'A', 'Factorise to find where the curve cuts the x-axis, then think about where it is below the axis.', '(x − 3)(x + 2) < 0. The graph is a U shape, below the axis between the roots: −2 < x < 3.', level=3))
assert sp.solve_univariate_inequality(4 - 4 * k > 0, k, relational=False) == sp.Interval.open(-sp.oo, 1)
items.append(choice('For which values of k does x² + 2x + k = 0 have two different real roots?', ['k > 1', 'k < 1', 'k = 1', 'k < 4'], 'B', 'Two different real roots means b² − 4ac > 0.', '4 − 4k > 0, so k < 1.', level=3))
c_ok = [c for c in range(0, 20) if 36 - 4 * c < 0]
assert c_ok[0] == 10
items.append(num('x² − 6x + c = 0 has no real roots. Find the smallest whole number c can be.', 10, 'No real roots means b² − 4ac < 0.', '36 − 4c < 0, so c > 9. The smallest whole number is 10.', level=3))
packs.append({
    'id': 'g12-quadratics', 'version': 1, 'grade': 12, 'subject': 'Mathematics', 'syllabus': '8227',
    'topic': 'Equations, expressions, identities and inequalities', 'title': 'Completing the square and the discriminant', 'minutes': 30,
    'explanation': [
        'Completing the square writes a quadratic in the form (x + p)² + q. For x² + bx + c, p is half of b: x² + bx + c = (x + b/2)² − (b/2)² + c.',
        'Example: x² − 8x + 21 = (x − 4)² − 16 + 21 = (x − 4)² + 5.',
        'This form shows the turning point straight away. Because (x + p)² is never negative, y = (x + p)² + q has a minimum value of q, when x = −p. The turning point is (−p, q).',
        'If the x² term has a number a in front, take a out of the x terms first: 2x² + 12x + 7 = 2(x² + 6x) + 7 = 2(x + 3)² − 18 + 7 = 2(x + 3)² − 11.',
        'The discriminant of ax² + bx + c = 0 is b² − 4ac. If it is positive there are two different real roots; if it is 0 there is one repeated (equal) root; if it is negative there are no real roots.',
        'A line and a curve: set the two expressions for y equal and rearrange to a quadratic = 0. The line is a tangent when b² − 4ac = 0, cuts the curve twice when b² − 4ac > 0 and misses it when b² − 4ac < 0.',
        'Quadratic inequalities: find the roots, sketch the U-shaped graph, then read off where it is above (> 0) or below (< 0) the x-axis.',
    ],
    'keyPoints': ['x² + bx + c = (x + b/2)² − (b/2)² + c.', 'Turning point of (x + p)² + q is (−p, q).', 'b² − 4ac > 0: two roots; = 0: equal roots; < 0: none.', 'Tangent: b² − 4ac = 0.'],
    'examples': [
        {'q': 'Write x² − 8x + 21 in the form (x + p)² + q and state its minimum value.', 'steps': ['Half of −8 is −4, so start with (x − 4)² = x² − 8x + 16.', 'x² − 8x + 21 = (x − 4)² − 16 + 21 = (x − 4)² + 5.', 'The minimum value is 5, when x = 4.'], 'answer': '(x − 4)² + 5, minimum 5'},
        {'q': 'Find the values of k for which x² + kx + 9 = 0 has equal roots.', 'steps': ['Equal roots: b² − 4ac = 0.', 'k² − 4(1)(9) = 0, so k² = 36.', 'k = 6 or k = −6.'], 'answer': 'k = ±6'},
    ],
    'practice': items,
})
assert sp.expand((x - 4)**2 + 5) == x**2 - 8 * x + 21

# ---------------------------------------------------------------- Grade 12: differentiation
items = []
d = lambda e, at: sp.diff(sp.sympify(e), x).subs(x, at)
assert d('x**5', 2) == 80
items.append(num('y = x⁵. Find dy/dx when x = 2.', 80, 'Bring the power down and reduce it by 1.', 'dy/dx = 5x⁴ = 5 × 16 = 80.'))
assert d('3*x**2 - 7*x + 4', 2) == 5
items.append(num('y = 3x² − 7x + 4. Find dy/dx when x = 2.', 5, 'Differentiate each term. The 4 disappears.', 'dy/dx = 6x − 7 = 12 − 7 = 5.'))
assert d('6*sqrt(x)', 9) == 1
items.append(num('y = 6√x. Find dy/dx when x = 9.', 1, 'Write √x as x^(1/2) first.', 'y = 6x^(1/2), so dy/dx = 3x^(−1/2) = 3/√x = 3/3 = 1.', level=2))
assert d('8/x**2', 2) == -2
items.append(num('y = 8/x². Find dy/dx when x = 2.', -2, 'Write 8/x² as 8x⁻².', 'dy/dx = −16x⁻³ = −16/8 = −2.', level=2))
assert d('x**3 - 4*x', 1) == -1
items.append(num('Find the gradient of the curve y = x³ − 4x at the point (1, −3).', -1, 'The gradient is the value of dy/dx at that point.', 'dy/dx = 3x² − 4 = 3 − 4 = −1.'))
m = d('x**2 + 3*x', 1)
yy = 1 + 3
assert m == 5 and yy - m * 1 == -1
items.append(num('The tangent to y = x² + 3x at x = 1 has equation y = 5x + c. Find c.', -1, 'At x = 1, y = 4. The tangent passes through (1, 4).', 'y = 4 when x = 1, and 4 = 5(1) + c, so c = −1.', level=2))
assert -1 / d('x**2', 2) == sp.Rational(-1, 4)
items.append(num('Find the gradient of the normal to y = x² at x = 2.', '-0.25', 'The normal is at right angles to the tangent: gradient = −1 ÷ (gradient of tangent).', 'Tangent gradient = 2x = 4, so normal gradient = −1/4.', accept=['-1/4'], level=2))
assert sp.solve(sp.diff(x**2 - 8 * x + 3, x), x) == [4]
items.append(num('Find the x-coordinate of the stationary point of y = x² − 8x + 3.', 4, 'At a stationary point dy/dx = 0.', 'dy/dx = 2x − 8 = 0, so x = 4.'))
f = 2 * x**3 - 3 * x**2 - 12 * x + 1
assert set(sp.solve(sp.diff(f, x), x)) == {-1, 2} and sp.diff(f, x, 2).subs(x, 2) > 0
items.append(choice('y = 2x³ − 3x² − 12x + 1 has a stationary point at x = 2. What kind of stationary point is it?', ['A maximum', 'A minimum', 'A point of inflexion', 'It is not stationary'], 'B', 'Work out d²y/dx² at x = 2.', 'd²y/dx² = 12x − 6 = 18 at x = 2. This is positive, so it is a minimum.', level=3))
assert sp.diff(x**4, x, 2).subs(x, 1) == 12
items.append(num('y = x⁴. Find d²y/dx² when x = 1.', 12, 'Differentiate twice.', 'dy/dx = 4x³ and d²y/dx² = 12x² = 12.', level=2))
assert d('(2*x + 1)**3', 0) == 6
items.append(num('y = (2x + 1)³. Find dy/dx when x = 0.', 6, 'Chain rule: bring the power down, reduce it by 1, then multiply by the derivative of the inside (2).', 'dy/dx = 3(2x + 1)² × 2 = 6(2x + 1)² = 6 when x = 0.', level=3))
t = sp.symbols('t')
h = 20 * t - 5 * t**2
tt = sp.solve(sp.diff(h, t), t)[0]
assert tt == 2 and h.subs(t, tt) == 20
items.append(num('In a netball game, the height of the ball above its starting point is h = 20t − 5t² metres after t seconds. Find the greatest height, in metres.', 20, 'At the greatest height, dh/dt = 0.', 'dh/dt = 20 − 10t = 0 when t = 2. Then h = 40 − 20 = 20 m.', level=3))
rate = 2 * math.pi * 4 * 0.5
assert sig(rate) == '12.6'
items.append(num('The radius of a circle grows at 0.5 cm per second. How fast is the area A = πr² growing when r = 4 cm? Give your answer in cm² per second, correct to 3 significant figures.', sig(rate), 'dA/dt = dA/dr × dr/dt.', 'dA/dr = 2πr = 8π. dA/dt = 8π × 0.5 = 4π ≈ 12.6 cm² per second.', accept=['12.57', '12.566'], level=3))
packs.append({
    'id': 'g12-differentiation', 'version': 1, 'grade': 12, 'subject': 'Mathematics', 'syllabus': '8227',
    'topic': 'Differentiation (Mathematics 1)', 'title': 'Differentiation', 'minutes': 30,
    'explanation': [
        'The gradient of a curve changes from point to point. Differentiating gives a formula for the gradient, written dy/dx or f′(x).',
        'The power rule: if y = axⁿ then dy/dx = naxⁿ⁻¹. Bring the power down to multiply, then reduce the power by 1. A constant on its own differentiates to 0. Differentiate a sum term by term.',
        'Roots and fractions must be written as powers first: √x = x^(1/2) and 8/x² = 8x⁻².',
        'The gradient at a point is dy/dx with that x put in. The tangent at the point has this gradient; the normal is at right angles to it, so its gradient is −1 ÷ (tangent gradient).',
        'At a stationary point dy/dx = 0. Find d²y/dx² (differentiate again): if it is positive the point is a minimum, if it is negative it is a maximum.',
        'Chain rule for a bracket: if y = (ax + b)ⁿ then dy/dx = n(ax + b)ⁿ⁻¹ × a.',
        'Rates of change: dy/dx tells you how fast y changes as x changes. Connected rates use dA/dt = dA/dr × dr/dt.',
    ],
    'keyPoints': ['y = axⁿ gives dy/dx = naxⁿ⁻¹.', 'Write roots and fractions as powers first.', 'Stationary point: dy/dx = 0.', 'd²y/dx² > 0 minimum; < 0 maximum.'],
    'examples': [
        {'q': 'y = 2x³ − 6x² + 5. Find the gradient of the curve when x = 3.', 'steps': ['dy/dx = 6x² − 12x.', 'When x = 3: 6(9) − 12(3) = 54 − 36.', '= 18.'], 'answer': '18'},
        {'q': 'Find the stationary points of y = x³ − 3x² − 9x + 2 and say whether each is a maximum or a minimum.', 'steps': ['dy/dx = 3x² − 6x − 9 = 0, so x² − 2x − 3 = 0.', '(x − 3)(x + 1) = 0, so x = 3 or x = −1.', 'd²y/dx² = 6x − 6.', 'At x = 3 it is 12 (positive): a minimum. At x = −1 it is −12 (negative): a maximum.'], 'answer': 'Minimum at x = 3, maximum at x = −1'},
    ],
    'practice': items,
})
assert d('2*x**3 - 6*x**2 + 5', 3) == 18 and set(sp.solve(3 * x**2 - 6 * x - 9, x)) == {-1, 3}

# ---------------------------------------------------------------- Grade 12: logarithms and exponentials
items = []
L = lambda v, b: math.log(v) / math.log(b)
assert sp.log(32, 2) == 5
items.append(num('Find log₂ 32.', 5, 'To what power must 2 be raised to give 32?', '2⁵ = 32, so log₂ 32 = 5.'))
assert sp.log(sp.Rational(1, 100), 10) == -2
items.append(num('Find log₁₀ 0.01.', -2, '0.01 = 1/100. Write it as a power of 10.', '0.01 = 10⁻², so log₁₀ 0.01 = −2.'))
assert sp.simplify(sp.log(25, 10) + sp.log(4, 10)) == 2
items.append(num('Without a calculator, work out lg 25 + lg 4.', 2, 'log a + log b = log (ab).', 'lg 25 + lg 4 = lg 100 = 2.'))
assert sp.simplify(sp.log(54, 3) - sp.log(2, 3)) == 3
items.append(num('Without a calculator, work out log₃ 54 − log₃ 2.', 3, 'log a − log b = log (a/b).', 'log₃ (54 ÷ 2) = log₃ 27 = 3.', level=2))
assert 2**3 * 5 == 40
items.append(num('Write 3 lg 2 + lg 5 as a single logarithm lg k. Find k.', 40, '3 lg 2 = lg 2³.', '3 lg 2 + lg 5 = lg 8 + lg 5 = lg 40, so k = 40.', level=2))
v = L(50, 4)
assert sig(v) == '2.82'
items.append(num('Solve 4ˣ = 50. Give x correct to 3 significant figures.', sig(v), 'Take lg of both sides: x lg 4 = lg 50.', 'x = lg 50 ÷ lg 4 = 2.82 (3 s.f.).', accept=['2.822'], level=2))
v = L(100, 7)
assert sig(v) == '2.37'
items.append(num('Solve 7ˣ = 100. Give x correct to 3 significant figures.', sig(v), 'Take lg of both sides: x lg 7 = lg 100 = 2.', 'x = 2 ÷ lg 7 = 2.37 (3 s.f.).', accept=['2.367'], level=2))
v = math.log(12)
assert sig(v) == '2.48'
items.append(num('Solve eˣ = 12. Give x correct to 3 significant figures.', sig(v), 'Take ln of both sides.', 'x = ln 12 = 2.48 (3 s.f.).', accept=['2.485'], level=2))
v = math.exp(1.5)
assert sig(v) == '4.48'
items.append(num('Solve ln x = 1.5. Give x correct to 3 significant figures.', sig(v), 'ln x = 1.5 means x = e^1.5.', 'x = e^1.5 = 4.48 (3 s.f.).', accept=['4.482'], level=2))
v = L(40, 2) - 1
assert sig(v) == '4.32'
items.append(num('Solve 2ˣ⁺¹ = 40. Give x correct to 3 significant figures.', sig(v), 'Take lg of both sides: (x + 1) lg 2 = lg 40.', 'x + 1 = lg 40 ÷ lg 2 = 5.322, so x = 4.32 (3 s.f.).', accept=['4.322'], level=3))
assert sp.solve(sp.Eq(sp.log(x + 3, 10), 2), x) == [97]
items.append(num('Solve lg (x + 3) = 2.', 97, 'lg (x + 3) = 2 means x + 3 = 10².', 'x + 3 = 100, so x = 97.', level=2))
v = 500 * math.exp(0.04 * 10)
assert round(v) == 746
items.append(num('The number of goats on a farm near Rundu is modelled by P = 500e^(0.04t), where t is the time in years. Find P when t = 10, to the nearest whole number.', 746, 'Put t = 10 into the formula: 500 × e^0.4.', 'P = 500e^0.4 = 745.9…, so about 746 goats.', level=3))
sols = [s_ for s_ in sp.solve(x * (x - 2) - 8, x) if s_ > 2]
assert sols == [4]
items.append(num('Solve log₂ x + log₂ (x − 2) = 3.', 4, 'Combine the logs: log₂ [x(x − 2)] = 3, so x(x − 2) = 8.', 'x² − 2x − 8 = 0, so (x − 4)(x + 2) = 0. x = −2 is not allowed (you cannot take the log of a negative number), so x = 4.', level=3))
packs.append({
    'id': 'g12-logs', 'version': 1, 'grade': 12, 'subject': 'Mathematics', 'syllabus': '8227',
    'topic': 'Logarithmic and exponential functions', 'title': 'Logarithms and exponentials', 'minutes': 30,
    'explanation': [
        'A logarithm answers the question "what power?". Because 2⁵ = 32, log₂ 32 = 5. In general, y = aˣ means the same as x = logₐ y.',
        'lg means log to base 10, and ln means log to base e (e ≈ 2.718). Your calculator has a button for each.',
        'The laws of logarithms (for any base): log a + log b = log (ab); log a − log b = log (a/b); n log a = log aⁿ. Also logₐ a = 1 and logₐ 1 = 0.',
        'To solve an equation like 3ˣ = 20, take lg (or ln) of both sides: x lg 3 = lg 20, so x = lg 20 ÷ lg 3.',
        'ln and e undo each other: ln (eˣ) = x and e^(ln x) = x. So eˣ = 12 gives x = ln 12, and ln x = 1.5 gives x = e^1.5.',
        'Exponential growth and decay are modelled by formulas like P = P₀e^(kt). Growth when k is positive, decay when k is negative.',
        'You can only take the log of a positive number. When you solve log equations, check each answer and reject any that would need the log of 0 or a negative number.',
    ],
    'keyPoints': ['y = aˣ ⇔ x = logₐ y.', 'log a + log b = log ab; log a − log b = log (a/b); n log a = log aⁿ.', 'Solve aˣ = b by taking logs of both sides.', 'ln and e undo each other.'],
    'examples': [
        {'q': 'Solve 2ˣ = 15, giving x correct to 3 significant figures.', 'steps': ['Take lg of both sides: lg 2ˣ = lg 15.', 'x lg 2 = lg 15.', 'x = lg 15 ÷ lg 2 = 1.1761 ÷ 0.3010.', 'x = 3.91 (3 s.f.).'], 'answer': 'x = 3.91'},
        {'q': 'Without a calculator, work out log₃ 81 and ln (e⁵).', 'steps': ['3⁴ = 81, so log₃ 81 = 4.', 'ln and e undo each other, so ln (e⁵) = 5.'], 'answer': '4 and 5'},
    ],
    'practice': items,
})
assert sig(L(15, 2)) == '3.91' and 3**4 == 81

# ---------------------------------------------------------------- answers on a basic phone (USSD)
# On a USSD screen a basic phone can only send digits (and * and #), so a learner
# cannot type a minus sign, a decimal point or a fraction. Questions whose answer is
# a whole number of 0 or more are typed as usual. For the others the build adds four
# choices: the answer and three likely mistakes (the sign wrong, a place-value slip,
# one more or one less). The answer's position changes from question to question.
def ussd_choices(answer, n):
    v = float(F(answer)) if '/' in answer else float(answer)
    dec = len(answer.split('.')[1]) if '.' in answer and '/' not in answer else (2 if '/' in answer else 0)
    def fmt(t):  # one more decimal place than the answer, without trailing zeros: 375, 3.75, 28.2, 0.282
        txt = f'{t:.{dec + 1}f}'.rstrip('0').rstrip('.')
        return '0' if txt in ('-0', '') else txt
    shown = answer if '/' not in answer else fmt(v)
    if v < 0:
        cands = [-v, v - 1, v + 1, 2 * v, v / 2]
    else:
        cands = [v * 10, v / 10, v + 1, v - 1, 2 * v]
    wrong = []
    for c in cands:
        t = fmt(c)
        if t != shown and t not in wrong and float(t) != v:
            wrong.append(t)
        if len(wrong) == 3:
            break
    assert len(wrong) == 3, (answer, wrong)
    pos = n % 4
    opts = wrong[:pos] + [shown] + wrong[pos:]
    assert abs(float(opts[pos]) - v) < 1e-9
    return {'options': opts, 'answer': 'ABCD'[pos]}


def typeable(answer):
    return '/' not in answer and '.' not in answer and not answer.startswith('-')


# ---------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
index = []
for p in packs:
    assert 10 <= len(p['practice']) <= 15, (p['id'], len(p['practice']))
    for i, it in enumerate(p['practice']):
        it['id'] = f"{p['id']}-{i + 1:02d}"
        if it['type'] == 'number':
            float(F(it['answer'])) if '/' in it['answer'] else float(it['answer'])
            if not typeable(it['answer']):
                it['ussd'] = ussd_choices(it['answer'], i)
    p['status_note'] = 'Draft for checking by a teacher. Learners see it only after it is marked as checked.'
    body = json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with open(os.path.join(OUT, p['id'] + '.json'), 'wb') as fh:
        fh.write(body)
    index.append({'id': p['id'], 'version': p['version'], 'grade': p['grade'], 'subject': p['subject'], 'syllabus': p['syllabus'],
                  'topic': p['topic'], 'title': p['title'], 'minutes': p['minutes'], 'items': len(p['practice']),
                  'bytes': len(gzip.compress(body, 9)) + 500})
with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as fh:
    json.dump({'updated': '2026-10-23', 'packs': index}, fh, ensure_ascii=False, separators=(',', ':'))
for e in index:
    print(f"{e['id']:22} {e['items']:2} items  about {e['bytes'] / 1024:.1f} KB to download")
