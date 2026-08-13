/**
 * K12Plus Arcade - built-in curriculum games, real-world scenarios and fun facts.
 * Grade 11-12, aligned to NSSCO/NSSCAS (NIED) and CAPS (DBE).
 * Every topic: keywords (for classifying learner questions), a game pack
 * (q = question, a = answer, f = accepted forms, h = hint, s = steps, d = difficulty),
 * a real-world story (real) and a fun fact (fact).
 * Works fully offline - no AI call needed to play.
 */
window.K12_ARCADE = {
  'Mathematics': [
    {
      name: 'Quadratic functions',
      keywords: ['quadratic', 'parabola', 'x²', 'x^2', 'turning point', 'vertex', 'roots', 'factorise', 'factorize', 'discriminant', 'completing the square'],
      fact: 'Every satellite dish and car headlight is a parabola: the shape of y = x² reflects all signals to one focus point.',
      real: '⚙️ Bridge engineers shape arches as parabolas because y = ax² spreads weight evenly. The arch y = 16 − x² stands 16 m tall and 8 m wide at the base.\n💰 A kapana seller\'s profit P = −q² + 20q − 64 rises, peaks, then falls: sell too little or too much and you lose. The peak at q = 10 plates is the sweet spot.\n⚽ A striker\'s shot follows h = −x² + 6x. The keeper knows the ball peaks at x = 3 m, so she positions for the drop.\nMaster parabolas and you can find the best point of almost anything.',
      game: [
        { e: '⚽', q: 'A striker\'s shot follows h = −x² + 6x metres. At what distance x (in metres) does the ball reach its highest point before dropping into the net?', a: '3', f: ['3', '3m', 'x=3'], h: 'The turning point is at x = −b ÷ 2a.', s: ['a = −1, b = 6', 'x = −6 ÷ (2 × −1) = 3'], d: 'easy' },
        { e: '🚗', q: 'A rally car must pass under an arch shaped y = 16 − x². How wide is the arch at ground level (y = 0), in metres?', a: '8', f: ['8', '8m'], h: 'Solve 16 − x² = 0, then find the distance between the two roots.', s: ['x² = 16 so x = 4 or x = −4', 'Width = 4 − (−4) = 8 m'], d: 'medium' },
        { e: '💰', q: 'A kapana stall\'s profit is P = −q² + 20q − 64 (N$) for q plates sold. What is the SMALLER number of plates where profit is exactly zero (break-even)?', a: '4', f: ['4', 'q=4', '4plates'], h: 'Set P = 0 and factorise q² − 20q + 64 = 0.', s: ['q² − 20q + 64 = 0', '(q − 4)(q − 16) = 0, so q = 4 or 16'], d: 'medium' },
        { e: '🎯', q: 'For the shot x² − 6x + k = 0 to touch the goal line exactly once (equal roots), what must k be?', a: '9', f: ['9', 'k=9'], h: 'Equal roots means the discriminant b² − 4ac = 0.', s: ['36 − 4k = 0', 'k = 9'], d: 'hard' }
      ]
    },
    {
      name: 'Sequences and series',
      keywords: ['sequence', 'series', 'arithmetic', 'geometric', 'common difference', 'common ratio', 'term', 'nth term', 'pattern'],
      fact: 'Sunflower seeds, pine cones and aloe spirals follow the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13…',
      real: '📱 Your data bundle halving each day (64 MB, 32, 16…) is a geometric sequence: you can predict exactly when it dies.\n💰 A savings plan of N$50, then N$60, then N$70 a month is arithmetic; the formula tells you your total after a year without adding it all up.\n🏟️ Stadium rows grow by the same number of seats each row: engineers use the arithmetic series formula to know total capacity in seconds.\nSequences turn patterns into predictions.',
      game: [
        { e: '📱', q: 'Your data bundle halves each day: 64 MB, 32, 16, … How many MB are left on day 6?', a: '2', f: ['2', '2mb'], h: 'Keep dividing by 2: it is a geometric sequence with r = ½.', s: ['64, 32, 16, 8, 4, 2', 'Day 6 = 2 MB'], d: 'easy' },
        { e: '🌱', q: 'A mahangu plant is 5 cm tall in week 1 and grows 3 cm every week. How tall (cm) is it in week 10?', a: '32', f: ['32', '32cm'], h: 'Arithmetic: Tₙ = a + (n − 1)d.', s: ['T₁₀ = 5 + 9 × 3', '= 5 + 27 = 32 cm'], d: 'medium' },
        { e: '🏟️', q: 'A stadium\'s first row has 20 seats and every row adds 4 more. How many seats are in row 12?', a: '64', f: ['64', '64seats'], h: 'Tₙ = a + (n − 1)d with a = 20, d = 4.', s: ['T₁₂ = 20 + 11 × 4', '= 20 + 44 = 64'], d: 'medium' },
        { e: '💰', q: 'Your kapana profit doubles every day starting at N$50: 50, 100, 200, … What is your TOTAL profit after 5 days (N$)?', a: '1550', f: ['1550', 'n$1550', '1550n$'], h: 'Add the geometric series 50 + 100 + 200 + 400 + 800.', s: ['Sum = 50(2⁵ − 1)/(2 − 1)', '= 50 × 31 = N$1550'], d: 'hard' }
      ]
    },
    {
      name: 'Financial mathematics',
      keywords: ['interest', 'simple interest', 'compound', 'depreciation', 'loan', 'investment', 'principal', 'hire purchase', 'inflation'],
      fact: 'Einstein reportedly called compound interest the eighth wonder of the world: those who understand it, earn it; those who do not, pay it.',
      real: '🏦 Save N$2000 at 10% compound and it becomes N$2420 in two years without you lifting a finger: interest starts earning its own interest.\n🚗 A N$60 000 car loses 20% of its value every year: after two years it is worth only N$38 400. Buyers who know depreciation never overpay.\n📱 A phone on hire purchase looks cheap per month, but adding every payment often shows you paid a third more than the sticker price.\nMoney maths is self-defence for your wallet.',
      game: [
        { e: '💰', q: 'You invest N$1000 at 8% simple interest per year. How much INTEREST (N$) do you earn after 3 years?', a: '240', f: ['240', 'n$240', '240n$'], h: 'Simple interest = P × i × n.', s: ['I = 1000 × 0.08 × 3', '= N$240'], d: 'easy' },
        { e: '📱', q: 'A phone costs N$4800 and the shop wants a 25% deposit. How much is the deposit (N$)?', a: '1200', f: ['1200', 'n$1200'], h: '25% is a quarter.', s: ['4800 × 0.25 = 1200'], d: 'easy' },
        { e: '🏦', q: 'N$2000 is saved at 10% COMPOUND interest per year. What is the total amount (N$) after 2 years?', a: '2420', f: ['2420', 'n$2420'], h: 'A = P(1 + i)ⁿ.', s: ['A = 2000 × 1.1²', '= 2000 × 1.21 = N$2420'], d: 'medium' },
        { e: '🚗', q: 'A bakkie worth N$60 000 depreciates at 20% per year on reducing balance. What is it worth (N$) after 2 years?', a: '38400', f: ['38400', 'n$38400', '38400n$'], h: 'Multiply by 0.8 each year.', s: ['60000 × 0.8 = 48000', '48000 × 0.8 = N$38 400'], d: 'hard' }
      ]
    },
    {
      name: 'Trigonometry',
      keywords: ['trigonometry', 'sine', 'cosine', 'tangent', 'sin', 'cos', 'tan', 'angle of elevation', 'bearing', 'hypotenuse', 'triangle'],
      fact: 'Cell towers, GPS and even the pyramids of Egypt were positioned using trigonometry: triangles have been engineering\'s secret weapon for 4000 years.',
      real: '📡 Technicians point a satellite dish using the elevation angle: tan of the angle links the tower height to your distance from it.\n🪜 A builder\'s ladder at the safe 75° angle, a roof truss at 30°: every safe construction site is applied trigonometry.\n⚽ A winger judging a cross calculates, without knowing it, the angle to the far post: brains run trig constantly in sport.\nLearn the ratios and every height and distance becomes measurable without a tape.',
      game: [
        { e: '🪜', q: 'A 10 m ladder leans against a wall making 30° with the GROUND. How high (m) up the wall does it reach? (sin 30° = 0.5)', a: '5', f: ['5', '5m'], h: 'Height = ladder × sin(angle).', s: ['h = 10 × sin 30°', '= 10 × 0.5 = 5 m'], d: 'easy' },
        { e: '🌳', q: 'A camelthorn tree casts a 20 m shadow when the sun\'s elevation is 45°. How tall (m) is the tree? (tan 45° = 1)', a: '20', f: ['20', '20m'], h: 'tan 45° = height ÷ shadow.', s: ['h = 20 × tan 45°', '= 20 × 1 = 20 m'], d: 'medium' },
        { e: '📡', q: 'For a signal tower angle, tan θ = 3/4. What is sin θ? (Think of the 3-4-5 triangle.)', a: '0.6', f: ['0.6', '3/5', '0,6'], h: 'Opposite 3, adjacent 4, so hypotenuse 5.', s: ['3² + 4² = 25, hypotenuse = 5', 'sin θ = 3/5 = 0.6'], d: 'medium' },
        { e: '🛠️', q: 'A rope pulls a crate with a force of 8 N at 60° to the ground. What is the horizontal part of the force (N)? (cos 60° = 0.5)', a: '4', f: ['4', '4n'], h: 'Horizontal component = F × cos θ.', s: ['8 × cos 60°', '= 8 × 0.5 = 4 N'], d: 'hard' }
      ]
    },
    {
      name: 'Coordinate geometry',
      keywords: ['coordinate', 'gradient', 'midpoint', 'distance formula', 'straight line', 'y=mx', 'slope', 'perpendicular', 'parallel'],
      fact: 'Google Maps is coordinate geometry at planet scale: every place on Earth is just an (x, y) pair called longitude and latitude.',
      real: '🗺️ Delivery apps find the halfway meeting point between you and the driver with the midpoint formula.\n🚕 A taxi\'s shortest route across open ground is the distance formula: √((x₂−x₁)² + (y₂−y₁)²).\n📈 A business plots sales month by month; the gradient of the line IS the growth rate: steeper line, faster growth.\nCoordinates turn maps and graphs into numbers you can calculate with.',
      game: [
        { e: '🗺️', q: 'You are at (2, 4) and your friend is at (6, 8) on the town grid. At which point do you meet halfway? Answer like (x;y).', a: '(4;6)', f: ['(4;6)', '4;6', '(4.6)', '(4,6)', '4.6'], h: 'Average the x values and the y values.', s: ['x: (2+6)/2 = 4', 'y: (4+8)/2 = 6'], d: 'easy' },
        { e: '🚕', q: 'A taxi cuts straight from (0, 0) to (3, 4) across the open market square (units in km). How far (km) is that?', a: '5', f: ['5', '5km'], h: 'Distance = √(3² + 4²).', s: ['√(9 + 16) = √25', '= 5 km'], d: 'medium' },
        { e: '📈', q: 'A shop\'s sales line passes through (1, 2) and (4, 11) on the graph. What is the gradient (growth rate)?', a: '3', f: ['3', 'm=3'], h: 'Gradient = (y₂ − y₁) ÷ (x₂ − x₁).', s: ['(11 − 2) ÷ (4 − 1)', '= 9 ÷ 3 = 3'], d: 'medium' },
        { e: '🛣️', q: 'A new road must cross y = 2x + 3 at a perfect right angle. What must the new road\'s gradient be?', a: '-0.5', f: ['-0.5', '-1/2', '-0,5'], h: 'Perpendicular gradients multiply to −1.', s: ['m × 2 = −1', 'm = −½ = −0.5'], d: 'hard' }
      ]
    },
    {
      name: 'Probability and statistics',
      keywords: ['probability', 'statistics', 'mean', 'median', 'mode', 'chance', 'dice', 'random', 'average', 'data'],
      fact: 'Insurance companies, weather forecasts and even penalty shoot-out tactics are all probability: the maths of not knowing for sure.',
      real: '⚽ Goalkeepers study where strikers shot before: if 7 of 10 penalties went left, diving left wins the probability game.\n💰 A spaza shop owner tracks the mean daily sales to know how much bread to order, and the mode to know the most popular cooldrink.\n🌧️ "60% chance of rain" is a probability model built from years of data: farmers plant by it.\nStatistics is how you make smart decisions with incomplete information.',
      game: [
        { e: '🎲', q: 'You roll one fair die at family game night. What is the probability of rolling a 6? Answer as a fraction.', a: '1/6', f: ['1/6', '0.17', '0.167', '0.1667'], h: 'One winning face out of six equal faces.', s: ['P = favourable ÷ total', '= 1/6'], d: 'easy' },
        { e: '📊', q: 'Your last five Maths test marks are 4, 6, 8, 10 and 12 out of 20. What is your mean mark?', a: '8', f: ['8', '8/20'], h: 'Add them all, divide by how many.', s: ['4+6+8+10+12 = 40', '40 ÷ 5 = 8'], d: 'easy' },
        { e: '🧦', q: 'A drawer has 3 red and 2 blue socks. You grab one in the dark. What is P(red)? Answer as a decimal.', a: '0.6', f: ['0.6', '3/5', '0,6'], h: 'Red socks over total socks.', s: ['P = 3 ÷ 5', '= 0.6'], d: 'medium' },
        { e: '🏀', q: 'You sink free throws with probability 0.5. What is the probability you sink BOTH of your next two? Answer as a decimal.', a: '0.25', f: ['0.25', '1/4', '0,25', '25%'], h: 'Multiply the probabilities of independent events.', s: ['0.5 × 0.5', '= 0.25'], d: 'hard' }
      ]
    }
  ],
  'Biology': [
    {
      name: 'Cells and transport',
      keywords: ['cell', 'osmosis', 'diffusion', 'membrane', 'mitochondria', 'nucleus', 'organelle', 'active transport', 'magnification'],
      fact: 'Your body replaces about 330 billion cells every single day: by next month, much of you is brand new.',
      real: '🥔 Salted meat and biltong survive without a fridge because salt pulls water out of bacteria by osmosis, so they die of thirst.\n💧 Farmers who over-fertilise burn their crops: the soil water becomes so concentrated that osmosis sucks water OUT of the roots.\n🏃 Every breath you take works by diffusion: oxygen drifts from your lungs into your blood entirely for free, no pump needed.\nUnderstand cells and you understand cooking, farming and your own body.',
      game: [
        { e: '🥔', q: 'A potato strip soaked in strong salt water becomes soft and shorter. By which process did water LEAVE its cells?', a: 'osmosis', f: ['osmosis'], h: 'Water moving through a membrane from weak to strong solution.', s: ['Salt water is more concentrated than cell sap', 'Water moves out by osmosis'], d: 'easy' },
        { e: '🫁', q: 'Oxygen moves from your alveoli into your blood, from high to low concentration. Name this process.', a: 'diffusion', f: ['diffusion'], h: 'No energy needed: particles spread from high to low concentration.', s: ['Movement down a concentration gradient', 'That is diffusion'], d: 'easy' },
        { e: '🔋', q: 'A sprinter\'s muscle cells are packed with which organelle, the site of respiration that releases energy?', a: 'mitochondria', f: ['mitochondria', 'mitochondrion'], h: 'The powerhouse of the cell.', s: ['Respiration happens in mitochondria', 'More energy needed = more mitochondria'], d: 'medium' },
        { e: '🔬', q: 'Under your school microscope a cell image is 50 mm wide but the real cell is 0.5 mm. What is the magnification (×)?', a: '100', f: ['100', 'x100', '100x', '×100'], h: 'Magnification = image size ÷ actual size.', s: ['50 ÷ 0.5', '= ×100'], d: 'hard' }
      ]
    },
    {
      name: 'Enzymes',
      keywords: ['enzyme', 'catalyst', 'substrate', 'amylase', 'optimum', 'denatured', 'lock and key', 'protease', 'lipase'],
      fact: 'Without enzymes, digesting one meal would take you about 50 years: enzymes speed reactions up to a million times.',
      real: '🧼 "Biological" washing powders contain protease and lipase enzymes that eat the protein and fat in stains, which is why they wash best at warm, not boiling, temperatures.\n🍞 Bread rises because yeast enzymes break sugar into gas bubbles; brewing oshikundu uses the very same chemistry.\n🍚 Chew bread long enough and it turns sweet: your saliva\'s amylase is breaking starch into sugar in your mouth right now.\nEnzymes are nature\'s tiny machines and industry hires them daily.',
      game: [
        { e: '🍚', q: 'Chewing bread long enough makes it taste sweet. Name the enzyme in saliva breaking starch into sugar.', a: 'amylase', f: ['amylase', 'salivaryamylase'], h: 'It starts with A and works on starch.', s: ['Salivary amylase digests starch', 'Starch → maltose (sweet)'], d: 'easy' },
        { e: '🌡️', q: 'Boiling water ruins biological washing powder. Above about 45 °C an enzyme\'s shape is destroyed: we say it is…?', a: 'denatured', f: ['denatured', 'denature', 'denaturated'], h: 'The active site loses its shape permanently.', s: ['High heat changes the active site', 'The enzyme is denatured'], d: 'medium' },
        { e: '🧼', q: 'Enzymes work fastest at one special temperature, around 37 °C in humans. What is this temperature called? (One word.)', a: 'optimum', f: ['optimum', 'optimumtemperature', 'optimal'], h: 'The "best" temperature.', s: ['Fastest reaction rate = optimum temperature'], d: 'medium' },
        { e: '🔒', q: 'The substrate fits into the enzyme\'s active site exactly like a key in a…? (Completes the model\'s name.)', a: 'lock', f: ['lock', 'lockandkey', 'alock'], h: 'The model is named after door hardware.', s: ['Lock and key model', 'Substrate = key, enzyme = lock'], d: 'hard' }
      ]
    },
    {
      name: 'Photosynthesis',
      keywords: ['photosynthesis', 'chlorophyll', 'chloroplast', 'light', 'starch', 'glucose', 'stomata', 'leaf', 'co₂', 'carbon dioxide'],
      fact: 'Every breath of oxygen you have ever taken was made by photosynthesis, and half of it came from ocean plankton, not trees.',
      real: '🌾 A mahangu field is a solar farm: every grain of the harvest is sunlight converted into stored glucose.\n💰 Greenhouse farmers pump in extra CO₂ and light to speed photosynthesis, growing tomatoes faster and selling more.\n🌍 Forests are the planet\'s lungs in reverse: they inhale our CO₂ and exhale the O₂ that keeps every animal alive.\nWhoever understands photosynthesis understands where all food and oxygen come from.',
      game: [
        { e: '☀️', q: 'Photosynthesis releases the gas that keeps you alive. Name it.', a: 'oxygen', f: ['oxygen', 'o2', 'o₂'], h: 'You breathe it in; plants breathe it out.', s: ['CO₂ + H₂O → glucose + oxygen'], d: 'easy' },
        { e: '🌿', q: 'Which green pigment in chloroplasts traps sunlight for photosynthesis?', a: 'chlorophyll', f: ['chlorophyll', 'chlorophyl'], h: 'It gives leaves their green colour.', s: ['Chlorophyll absorbs light energy'], d: 'easy' },
        { e: '🌱', q: 'Complete the word equation: carbon dioxide + ? → glucose + oxygen (in light, with chlorophyll).', a: 'water', f: ['water', 'h2o', 'h₂o'], h: 'It comes up from the roots.', s: ['6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂'], d: 'medium' },
        { e: '🥬', q: 'In full sun a mahangu plant makes 6 g of glucose per hour. How many grams in 4 hours of sunshine?', a: '24', f: ['24', '24g'], h: 'Multiply rate by time.', s: ['6 × 4 = 24 g'], d: 'medium' }
      ]
    },
    {
      name: 'Human gas exchange and smoking',
      keywords: ['lungs', 'alveoli', 'smoking', 'tar', 'cilia', 'gas exchange', 'breathing', 'trachea', 'bronchi', 'emphysema'],
      fact: 'Spread flat, the alveoli in your lungs would cover half a tennis court: that huge surface is why one breath refuels your whole bloodstream.',
      real: '🏃 Marathon runners train at altitude so their bodies build more red blood cells, squeezing more from every breath.\n🚬 One cigarette paralyses the cilia (tiny sweepers) in your airways for hours, letting tar and dust settle deep in the lungs.\n🩺 Doctors read oxygen saturation from a finger clip: gas exchange turned into a number, 98% means your alveoli are doing their job.\nYour lungs are engineering marvels: knowing how they work helps you protect them.',
      game: [
        { e: '🫁', q: 'Name the millions of tiny air sacs in the lungs where oxygen enters the blood.', a: 'alveoli', f: ['alveoli', 'alveolus'], h: 'They look like bunches of tiny grapes.', s: ['Gas exchange happens across the alveoli walls'], d: 'easy' },
        { e: '🚬', q: 'Which sticky brown substance in cigarette smoke coats the lungs and causes cancer?', a: 'tar', f: ['tar'], h: 'The same word as the black stuff on roads.', s: ['Tar collects in airways and alveoli', 'It contains carcinogens'], d: 'medium' },
        { e: '🏃', q: 'During a netball sprint your breathing speeds up to supply extra…? (Name the gas.)', a: 'oxygen', f: ['oxygen', 'o2', 'o₂'], h: 'Muscles need it for respiration.', s: ['More respiration needs more oxygen', 'Breathing rate rises to deliver it'], d: 'medium' },
        { e: '💨', q: 'An adult at rest breathes 15 times per minute, moving 0.5 litres each breath. How many litres of air per minute?', a: '7.5', f: ['7.5', '7,5', '7.5l', '7.5litres'], h: 'Multiply breaths by volume.', s: ['15 × 0.5', '= 7.5 litres/minute'], d: 'hard' }
      ]
    },
    {
      name: 'Genetics and inheritance',
      keywords: ['genetics', 'allele', 'dominant', 'recessive', 'dna', 'chromosome', 'punnett', 'gene', 'inheritance', 'heterozygous', 'homozygous'],
      fact: 'You share about 99.9% of your DNA with every other human, and around 60% with a banana.',
      real: '🐄 Cattle farmers pay top prices for bulls with proven genes: one Punnett square can predict the calves\' coat colour and hardiness.\n👶 Hospitals screen newborns for inherited conditions; a single letter change in DNA out of 3 billion can matter.\n🌾 Drought-resistant mahangu varieties exist because breeders selected the right alleles generation after generation.\nGenetics is farming, medicine and family history written in a four-letter code.',
      game: [
        { e: '🧬', q: 'Name the molecule, shaped as a double helix, that carries your genetic code.', a: 'dna', f: ['dna'], h: 'Three letters.', s: ['DNA = deoxyribonucleic acid'], d: 'easy' },
        { e: '🧮', q: 'How many chromosomes are in a normal human body cell?', a: '46', f: ['46', '46chromosomes', '23pairs'], h: '23 pairs.', s: ['23 pairs × 2 = 46'], d: 'easy' },
        { e: '🐄', q: 'An allele that only shows its effect when BOTH copies are present is called…?', a: 'recessive', f: ['recessive'], h: 'The opposite of dominant.', s: ['Dominant masks it in Tt', 'Only tt shows the recessive trait'], d: 'medium' },
        { e: '👨‍👩‍👧', q: 'Two Tt parents have a child. Using a Punnett square, what fraction of offspring are expected to be tt? Answer as a fraction.', a: '1/4', f: ['1/4', '0.25', '25%', '0,25'], h: 'Draw the 2×2 square: TT, Tt, Tt, tt.', s: ['Tt × Tt → TT, Tt, Tt, tt', 'tt = 1 out of 4'], d: 'hard' }
      ]
    },
    {
      name: 'Ecology and ecosystems',
      keywords: ['ecosystem', 'food chain', 'food web', 'producer', 'consumer', 'energy transfer', 'decomposer', 'population', 'habitat', 'trophic'],
      fact: 'Only about 10% of energy passes up each level of a food chain, which is why lions are rare and grass is everywhere.',
      real: '🦁 Etosha\'s balance depends on energy maths: thousands of springbok can only support a handful of lions because 90% of energy is lost at each step.\n🌾 Farmers rest their grazing camps because a population of cattle beyond the land\'s carrying capacity crashes the whole system.\n🍄 Decomposers are the recycling plant of nature: without fungi and bacteria, dead matter would pile up and soil would starve.\nEcology is the economics of nature, and every farmer is trading in it.',
      game: [
        { e: '🌾', q: 'In the food chain grass → springbok → lion, what do we call the grass, which makes its own food?', a: 'producer', f: ['producer', 'producers'], h: 'It "produces" food from sunlight.', s: ['Green plants are producers'], d: 'easy' },
        { e: '🍄', q: 'Which organisms break down dead plants and animals, returning nutrients to the soil?', a: 'decomposers', f: ['decomposers', 'decomposer'], h: 'Fungi and bacteria do this job.', s: ['Decomposers recycle nutrients'], d: 'easy' },
        { e: '🦁', q: 'Grass in a camp stores 1000 kJ of energy. Roughly how many kJ reach the springbok level (10% rule)?', a: '100', f: ['100', '100kj'], h: 'Only about 10% transfers up each level.', s: ['1000 × 10%', '= 100 kJ'], d: 'medium' },
        { e: '🌍', q: 'All the springbok living together in one part of Etosha are called a…? (One word.)', a: 'population', f: ['population'], h: 'One species, one area, one word.', s: ['Same species + same area = population'], d: 'medium' }
      ]
    }
  ],
  'Physical Science': [
    {
      name: 'Motion and forces',
      keywords: ['speed', 'velocity', 'acceleration', 'force', 'newton', 'friction', 'momentum', 'f=ma', 'motion', 'distance', 'displacement'],
      fact: 'A falling raindrop would hit you at 340 km/h without air resistance: friction with air is the umbrella you never see.',
      real: '🚗 Speed cameras use v = distance ÷ time over marked road sections: the same formula in your exam catches real speeders.\n⚽ A penalty kick is F = ma live: the harder the boot force on the 0.4 kg ball, the greater its acceleration off the spot.\n🛑 Braking distance grows with the SQUARE of speed: at double the speed a taxi needs four times the road to stop. That is why speed limits exist.\nMotion maths is the physics of staying alive on the road.',
      game: [
        { e: '🚗', q: 'A taxi covers 60 km in half an hour on the B1. What is its average speed in km/h?', a: '120', f: ['120', '120km/h', '120kmh'], h: 'Speed = distance ÷ time.', s: ['60 ÷ 0.5', '= 120 km/h'], d: 'easy' },
        { e: '⚽', q: 'Your boot gives a 0.4 kg football an acceleration of 25 m/s². What force (N) did you kick with? (F = ma)', a: '10', f: ['10', '10n'], h: 'Multiply mass by acceleration.', s: ['F = 0.4 × 25', '= 10 N'], d: 'medium' },
        { e: '🛞', q: 'A car travelling at 20 m/s brakes and stops in 4 s. What is the size of its deceleration (m/s²)?', a: '5', f: ['5', '5m/s²', '5m/s2', '-5'], h: 'a = change in speed ÷ time.', s: ['20 ÷ 4', '= 5 m/s²'], d: 'medium' },
        { e: '🚚', q: 'A 1500 kg bakkie travels at 20 m/s. Calculate its momentum (kg·m/s).', a: '30000', f: ['30000', '30000kgm/s', '30000kg·m/s'], h: 'Momentum = mass × velocity.', s: ['p = 1500 × 20', '= 30 000 kg·m/s'], d: 'hard' }
      ]
    },
    {
      name: 'Electricity',
      keywords: ['current', 'voltage', 'resistance', 'ohm', 'circuit', 'power', 'watt', 'v=ir', 'ampere', 'series', 'parallel', 'electricity'],
      fact: 'Lightning is a current of about 30 000 amps, two million times more than the 0.015 A that can already stop a human heart.',
      real: '💡 Prepaid electricity is P = VI in action: a 2000 W kettle eats your units ten times faster than a 200 W TV.\n🔋 A solar home system is sized with V = IR: get the resistance wrong and your battery drains before the evening study session ends.\n⚡ Fuses melt on purpose: they are thin wires that sacrifice themselves when current climbs too high, saving the house.\nUnderstand circuits and you can wire a solar panel, save units and stay safe.',
      game: [
        { e: '🔌', q: 'A 12 V battery pushes 2 A through a resistor. What is the resistance in ohms? (V = IR)', a: '6', f: ['6', '6ω', '6ohm', '6ohms'], h: 'R = V ÷ I.', s: ['R = 12 ÷ 2', '= 6 Ω'], d: 'easy' },
        { e: '💡', q: 'A bulb runs on 220 V drawing 0.5 A. What is its power in watts? (P = VI)', a: '110', f: ['110', '110w'], h: 'Multiply voltage by current.', s: ['P = 220 × 0.5', '= 110 W'], d: 'medium' },
        { e: '🔋', q: 'In a SERIES circuit with three bulbs, how does the current at each bulb compare? (One word.)', a: 'same', f: ['same', 'thesame', 'equal', 'identical'], h: 'There is only one path for the charge.', s: ['Series = one loop', 'Current is the same everywhere'], d: 'medium' },
        { e: '⚡', q: 'A 2000 W kettle runs for 3 minutes. How much energy does it use in kilojoules? (E = Pt)', a: '360', f: ['360', '360kj'], h: 'Convert minutes to seconds first.', s: ['E = 2000 × 180 = 360 000 J', '= 360 kJ'], d: 'hard' }
      ]
    },
    {
      name: 'Waves, light and sound',
      keywords: ['wave', 'frequency', 'wavelength', 'reflection', 'refraction', 'sound', 'light', 'v=fλ', 'echo', 'hertz', 'amplitude'],
      fact: 'Light is about 880 000 times faster than sound: you see the lightning first and count the seconds to know how far the storm is.',
      real: '⛈️ Count seconds between lightning and thunder, multiply by 340 m/s, and you have the storm\'s distance: farmers do this instinctively.\n📱 Your phone, radio and Wi-Fi all obey v = fλ: each service just uses a different frequency lane on the same invisible highway.\n🐬 Sonar and ultrasound scans are echoes with maths: time the reflection, halve it, multiply by speed, and you can see a baby or the sea floor.\nWaves carry every message, image and song you have ever received.',
      game: [
        { e: '📻', q: 'Sound travels at 340 m/s. A note has frequency 170 Hz. What is its wavelength in metres? (v = fλ)', a: '2', f: ['2', '2m'], h: 'λ = v ÷ f.', s: ['340 ÷ 170', '= 2 m'], d: 'easy' },
        { e: '🪞', q: 'A light ray hits a mirror at 30° to the normal. At what angle (degrees) does it reflect?', a: '30', f: ['30', '30°', '30degrees'], h: 'Angle of incidence = angle of reflection.', s: ['Law of reflection: i = r = 30°'], d: 'easy' },
        { e: '🌈', q: 'A straw in a glass of water looks bent because light changes speed and direction entering water. Name this effect.', a: 'refraction', f: ['refraction'], h: 'Not reflection: the light passes THROUGH.', s: ['Light bends at the boundary', 'That is refraction'], d: 'medium' },
        { e: '⛈️', q: 'Thunder arrives 3 s after the lightning flash. Sound travels at 340 m/s. How far away (m) is the storm?', a: '1020', f: ['1020', '1020m', '1.02km'], h: 'Distance = speed × time.', s: ['340 × 3', '= 1020 m'], d: 'hard' }
      ]
    },
    {
      name: 'Acids, bases and salts',
      keywords: ['acid', 'base', 'alkali', 'ph', 'neutral', 'indicator', 'salt', 'neutralise', 'litmus', 'universal indicator'],
      fact: 'Your stomach acid is strong enough to dissolve a razor blade, and your stomach grows a new lining every few days to survive it.',
      real: '🐄 Farmers spread lime on acidic soil to neutralise it: pH decides whether mahangu roots can take up nutrients at all.\n🦷 Fizzy drinks sit at about pH 3; your tooth enamel starts dissolving below pH 5.5. Dentists are really chemists.\n🧴 Bee sting? Acidic: soothe with bicarbonate. Wasp sting? Alkaline: soothe with vinegar. Neutralisation is first aid.\nAcid-base chemistry runs your kitchen, your farm and your body.',
      game: [
        { e: '💧', q: 'What is the pH of pure, neutral water?', a: '7', f: ['7', 'ph7'], h: 'Right in the middle of the 0-14 scale.', s: ['Neutral = pH 7'], d: 'easy' },
        { e: '🧪', q: 'Complete: acid + base → salt + …?', a: 'water', f: ['water', 'h2o', 'h₂o'], h: 'The other product of neutralisation.', s: ['Neutralisation: acid + base → salt + water'], d: 'easy' },
        { e: '🐄', q: 'A farmer\'s soil is too acidic for mahangu, so she adds lime. What is she doing to the acid? (One word.)', a: 'neutralising', f: ['neutralising', 'neutralizing', 'neutralise', 'neutralize', 'neutralisingit'], h: 'Bringing the pH toward 7.', s: ['Lime is a base', 'Base + acid = neutralisation'], d: 'medium' },
        { e: '🔴', q: 'Universal indicator is added to strong battery acid. What colour does it turn?', a: 'red', f: ['red'], h: 'The colour of danger, at pH 0-2.', s: ['Strong acid → red on the universal indicator scale'], d: 'medium' }
      ]
    },
    {
      name: 'Chemical reactions and moles',
      keywords: ['mole', 'mass', 'reaction', 'equation', 'balance', 'mr', 'relative molecular', 'stoichiometry', 'reactant', 'product'],
      fact: 'One mole is 602 000 000 000 000 000 000 000 particles: count that many grains of sand and you could bury the whole of Namibia metres deep.',
      real: '🏭 A cement plant weighs reactants by the tonne using the same mole ratios you learn: wrong ratio, wasted money, weak cement.\n💊 Pharmacists dose medicine with mole calculations: milligrams too many can harm, too few will not heal.\n🔥 Balancing CH₄ + 2O₂ → CO₂ + 2H₂O is how gas stove designers know exactly how much air each burner needs.\nStoichiometry is chemistry\'s recipe book, and industry cooks from it daily.',
      game: [
        { e: '⚖️', q: 'Using H = 1 and O = 16, what is the relative molecular mass (Mr) of water, H₂O?', a: '18', f: ['18', '18g/mol', 'mr18'], h: 'Two hydrogens plus one oxygen.', s: ['(2 × 1) + 16', '= 18'], d: 'easy' },
        { e: '🔥', q: 'Balance the gas stove reaction: CH₄ + ?O₂ → CO₂ + 2H₂O. What number goes before O₂?', a: '2', f: ['2', '2o2', '2o₂'], h: 'Count the oxygen atoms on the right.', s: ['Right side: 2 + 2 = 4 O atoms', 'So 2O₂ on the left'], d: 'medium' },
        { e: '🧂', q: 'Table salt NaCl has Mr = 58.5. How many moles are in 58.5 g of salt?', a: '1', f: ['1', '1mol', '1mole'], h: 'Moles = mass ÷ Mr.', s: ['58.5 ÷ 58.5', '= 1 mol'], d: 'medium' },
        { e: '🏭', q: 'Charcoal (12 g of carbon) burns completely: C + O₂ → CO₂. What mass of CO₂ forms (g)? (C = 12, O = 16)', a: '44', f: ['44', '44g'], h: 'One mole of C gives one mole of CO₂.', s: ['Mr of CO₂ = 12 + 32 = 44', '12 g C → 44 g CO₂'], d: 'hard' }
      ]
    },
    {
      name: 'Energy',
      keywords: ['energy', 'kinetic', 'potential', 'joule', 'efficiency', 'renewable', 'solar', 'conservation of energy', 'work'],
      fact: 'The Namib Desert receives more solar energy in a day than the whole world uses in a year: Namibia is a sleeping energy superpower.',
      real: '☀️ Namibia has some of the best sunshine on Earth: solar farms near Mariental turn free desert light into national grid power.\n🚵 A cyclist at the top of a dune holds a bank account of potential energy, mgh; the ride down converts it to kinetic, ½mv².\n💡 An old bulb wastes 80% of its energy as heat; an LED flips that ratio, which is why one lasts years on the same units.\nEnergy cannot be created or destroyed, but the smart learn to convert it profitably.',
      game: [
        { e: '☀️', q: 'Which renewable energy source is Namibia\'s most abundant, powering farms near Mariental?', a: 'solar', f: ['solar', 'sun', 'solarenergy', 'thesun', 'sunlight'], h: 'Look up at midday.', s: ['Namibia has world-class sunshine', 'Solar energy'], d: 'easy' },
        { e: '🚵', q: 'A 2 kg schoolbag is lifted onto a shelf 10 m up (g = 10 m/s²). How much potential energy does it gain (J)?', a: '200', f: ['200', '200j'], h: 'PE = mgh.', s: ['2 × 10 × 10', '= 200 J'], d: 'medium' },
        { e: '🏃', q: 'A 50 kg netball player sprints at 4 m/s. What is her kinetic energy (J)? (KE = ½mv²)', a: '400', f: ['400', '400j'], h: 'Half, times mass, times speed squared.', s: ['½ × 50 × 16', '= 400 J'], d: 'medium' },
        { e: '💡', q: 'A bulb takes in 100 J but gives out only 20 J of light. What is its efficiency as a percentage?', a: '20', f: ['20', '20%'], h: 'Useful out ÷ total in × 100.', s: ['20 ÷ 100 × 100', '= 20%'], d: 'hard' }
      ]
    }
  ],
  'Business Studies': [
    {
      name: 'Entrepreneurship',
      keywords: ['entrepreneur', 'business idea', 'opportunity', 'risk', 'innovation', 'start-up', 'startup', 'swot', 'business plan'],
      fact: 'Namibia\'s informal sector, from kapana grills to phone repair stands, employs more people than all its mines combined.',
      real: '💡 The kapana seller who moved her grill next to the taxi rank doubled sales: entrepreneurship is spotting where the customers already are.\n📊 Before borrowing a cent, smart founders run a SWOT: strengths, weaknesses, opportunities, threats, one page that saves thousands.\n🚀 MTC, Namib Mills and every big brand started as one person taking a calculated risk that others avoided.\nEntrepreneurs do not wait for jobs; they build them.',
      game: [
        { e: '💡', q: 'What do we call a person who spots an opportunity, takes the risk and starts a business?', a: 'entrepreneur', f: ['entrepreneur', 'anentrepreneur'], h: 'The subject of this whole topic.', s: ['Risk-taker + opportunity-spotter = entrepreneur'], d: 'easy' },
        { e: '🛒', q: 'A kapana seller spends N$300 on meat and spices and sells everything for N$480. What is her profit (N$)?', a: '180', f: ['180', 'n$180'], h: 'Profit = revenue − costs.', s: ['480 − 300', '= N$180'], d: 'easy' },
        { e: '📊', q: 'In a SWOT analysis, S, W and O stand for strengths, weaknesses and opportunities. What does T stand for?', a: 'threats', f: ['threats', 'threat'], h: 'The dangers coming from outside the business.', s: ['SWOT = Strengths, Weaknesses, Opportunities, Threats'], d: 'medium' },
        { e: '🚀', q: 'A trader buys stock for N$400 and makes N$100 profit. What is her percentage profit on cost?', a: '25', f: ['25', '25%'], h: 'Profit ÷ cost × 100.', s: ['100 ÷ 400 × 100', '= 25%'], d: 'hard' }
      ]
    },
    {
      name: 'Marketing',
      keywords: ['marketing', 'advertising', 'price', 'product', 'promotion', 'place', 'customer', '4ps', 'brand', 'target market', 'mark-up'],
      fact: 'The average person sees up to 10 000 adverts a day: marketing is the loudest conversation on Earth, and you are always in it.',
      real: '📣 A car wash that WhatsApps before-and-after photos to local groups spends N$0 and reaches hundreds: promotion has gone digital.\n🥤 Shops place sweets at the till on purpose: "place", one of the 4 Ps, is why you buy things you never planned to.\n🏷️ A 50% mark-up on cooldrinks pays the rent: pricing is a survival calculation, not a guess.\nMarketing is how small businesses punch above their weight.',
      game: [
        { e: '📣', q: 'The marketing mix has 4 Ps: product, price, place and …?', a: 'promotion', f: ['promotion'], h: 'Adverts, specials and sponsorships fall under it.', s: ['4 Ps: product, price, place, promotion'], d: 'easy' },
        { e: '🥤', q: 'A cooldrink costs the tuck shop N$8 and is marked up 50%. What is the selling price (N$)?', a: '12', f: ['12', 'n$12'], h: 'Add half of the cost on top.', s: ['8 + (8 × 0.5)', '= N$12'], d: 'medium' },
        { e: '🛍️', q: 'The specific group of customers a product is aimed at is called the target …? (One word.)', a: 'market', f: ['market', 'targetmarket'], h: 'Two words together: target ___.', s: ['Target market = intended customer group'], d: 'medium' },
        { e: '📱', q: 'Printing 200 flyers costs N$300 and brings in 30 new customers. What is the cost per new customer (N$)?', a: '10', f: ['10', 'n$10'], h: 'Total cost ÷ customers gained.', s: ['300 ÷ 30', '= N$10 per customer'], d: 'hard' }
      ]
    },
    {
      name: 'Financial literacy',
      keywords: ['budget', 'savings', 'loan', 'tax', 'vat', 'income', 'expenses', 'bank', 'interest rate', 'financial'],
      fact: 'If you save N$10 every day from age 16, at ordinary bank interest you would pass N$100 000 well before age 40.',
      real: '🧾 Every till slip in Namibia shows 15% VAT: on a N$100 grocery basket, N$13.04 was tax before you even noticed.\n💰 A budget is a mirror: income 4000, expenses 3200, and suddenly you can SEE the N$800 that used to vanish.\n💳 Borrowing N$10 000 casually at 12% means paying N$1 200 a year just for the privilege: interest never sleeps.\nFinancial literacy is the difference between owning money and money owning you.',
      game: [
        { e: '🧾', q: 'What is the VAT rate charged on most goods in Namibia (%)?', a: '15', f: ['15', '15%'], h: 'It is on every till slip.', s: ['Namibian VAT = 15%'], d: 'easy' },
        { e: '💰', q: 'Your monthly income is N$4000 and expenses are N$3200. How much can you save (N$)?', a: '800', f: ['800', 'n$800'], h: 'Income minus expenses.', s: ['4000 − 3200', '= N$800'], d: 'easy' },
        { e: '🏦', q: 'You save N$5000 at 6% simple interest per year. How much interest (N$) after one year?', a: '300', f: ['300', 'n$300'], h: '6% of 5000.', s: ['5000 × 0.06', '= N$300'], d: 'medium' },
        { e: '💳', q: 'A N$10 000 loan charges 12% simple interest per year. How much interest (N$) builds up in 6 months?', a: '600', f: ['600', 'n$600'], h: 'Half a year = half the annual interest.', s: ['10000 × 0.12 = 1200 per year', '÷ 2 = N$600'], d: 'hard' }
      ]
    },
    {
      name: 'Break-even and costs',
      keywords: ['break-even', 'breakeven', 'fixed cost', 'variable cost', 'revenue', 'profit', 'loss', 'total cost', 'contribution'],
      fact: 'Airlines sometimes fly at a loss per passenger but profit on the flight: break-even thinking decides whole industries.',
      real: '🍞 A home bakery pays N$1000 rent whether it bakes one loaf or a thousand: fixed costs do not care about your sales.\n📉 Selling below variable cost means every sale digs the hole deeper: knowing your numbers stops "busy but broke".\n🧮 Break-even = fixed costs ÷ (price − variable cost): one line of maths tells a founder exactly how many units survival takes.\nBusinesses fail from bad numbers more often than bad products.',
      game: [
        { e: '🏭', q: 'Rent stays N$1000 a month whether you sell 10 loaves or 1000. What TYPE of cost is rent? (One word.)', a: 'fixed', f: ['fixed', 'fixedcost', 'afixedcost'], h: 'It does not change with output.', s: ['Costs that stay constant = fixed costs'], d: 'easy' },
        { e: '📉', q: 'At the break-even point, total revenue is exactly equal to total …? (One word.)', a: 'costs', f: ['costs', 'cost', 'totalcosts', 'expenses'], h: 'No profit, no loss.', s: ['Break-even: revenue = total costs'], d: 'easy' },
        { e: '🍞', q: 'A bakery has fixed costs of N$1000. Each loaf sells for N$10 and costs N$6 to make. How many loaves to break even?', a: '250', f: ['250', '250loaves'], h: 'Fixed costs ÷ (price − variable cost).', s: ['Contribution = 10 − 6 = N$4', '1000 ÷ 4 = 250 loaves'], d: 'medium' },
        { e: '🧮', q: 'The bakery sells 300 loaves at N$10 each and total costs are N$2400. What is the profit (N$)?', a: '600', f: ['600', 'n$600'], h: 'Revenue minus total costs.', s: ['Revenue = 300 × 10 = 3000', '3000 − 2400 = N$600'], d: 'hard' }
      ]
    },
    {
      name: 'Business organisation',
      keywords: ['sole trader', 'partnership', 'company', 'shareholder', 'limited liability', 'cooperative', 'close corporation', 'ownership'],
      fact: 'The oldest company still running was founded in Japan in the year 578: good business structures can outlive empires.',
      real: '👤 A sole trader keeps every dollar of profit but also carries every dollar of debt: freedom and risk in one person.\n🤝 Partnerships add skills and capital but also shared blame: contracts exist because handshakes fade.\n🛡️ Limited liability is the deal that built the modern economy: shareholders can lose their shares, but never their homes.\nChoosing a business form is choosing how much risk sleeps in your own bed.',
      game: [
        { e: '👤', q: 'A business owned and run by one person, who keeps all profit and carries all risk, is called a sole …?', a: 'trader', f: ['trader', 'soletrader', 'proprietor', 'soleproprietor'], h: 'Sole ___.', s: ['One owner = sole trader'], d: 'easy' },
        { e: '🤝', q: 'The owners of a company, who each hold a piece of it, are called …?', a: 'shareholders', f: ['shareholders', 'shareholder'], h: 'They hold "shares".', s: ['Company owners = shareholders'], d: 'easy' },
        { e: '🛡️', q: 'Shareholders can only lose the money they invested, never their personal property. This protection is called …. liability.', a: 'limited', f: ['limited', 'limitedliability'], h: 'The L in (Pty) Ltd.', s: ['Limited liability protects personal assets'], d: 'medium' },
        { e: '🏢', q: 'A business owned by its members, run for their shared benefit (like many savings and farming groups), is called a …?', a: 'cooperative', f: ['cooperative', 'co-operative', 'coop', 'co-op'], h: 'The members co-operate.', s: ['Member-owned = cooperative'], d: 'hard' }
      ]
    },
    {
      name: 'Production and employment',
      keywords: ['production', 'productivity', 'wages', 'salary', 'quality', 'labour', 'output', 'efficiency', 'employment', 'overtime'],
      fact: 'Assembly-line thinking cut the time to build a car from 12 hours to 93 minutes in 1913, and changed world wages forever.',
      real: '🏭 A carpentry shop that jigs its cuts makes 50 chairs per worker instead of 30: productivity, not harder work, raises wages.\n⏱️ Overtime pays more because rested workers are safer and sharper: labour law is economics with a conscience.\n📦 One faulty product can cost ten loyal customers: quality control is the cheapest marketing there is.\nProduction numbers decide salaries, prices and who wins the market.',
      game: [
        { e: '🏭', q: 'A worker paid a fixed amount per month, regardless of hours, earns a …? (One word.)', a: 'salary', f: ['salary', 'asalary'], h: 'Wages are hourly; this is monthly.', s: ['Fixed monthly pay = salary'], d: 'easy' },
        { e: '💵', q: 'A welder earns N$25 per hour and works 40 hours this week. What is her wage (N$)?', a: '1000', f: ['1000', 'n$1000'], h: 'Rate × hours.', s: ['25 × 40', '= N$1000'], d: 'easy' },
        { e: '⏱️', q: 'Four workers make 200 chairs in a week. What is the productivity per worker (chairs)?', a: '50', f: ['50', '50chairs'], h: 'Total output ÷ number of workers.', s: ['200 ÷ 4', '= 50 chairs per worker'], d: 'medium' },
        { e: '📦', q: 'A factory produces 500 units and 2% are faulty. How many GOOD units are made?', a: '490', f: ['490', '490units'], h: 'Find 2% of 500, subtract it.', s: ['Faulty = 500 × 0.02 = 10', '500 − 10 = 490'], d: 'hard' }
      ]
    }
  ]
};
