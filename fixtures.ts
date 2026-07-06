// Sample corpus for vector search. A deliberately mixed set of short facts
// across several topics so that semantic ranking is easy to see: a query like
// "fast feline predator" should surface the cheetah line above the laptop line,
// even though it shares no exact words.

export interface Doc {
  id: number;
  text: string;
  category: string;
}

export const DOCS: Doc[] = [
  // animals
  { id: 1, text: "The cheetah is the fastest land animal, reaching speeds over 100 km/h.", category: "animals" },
  { id: 2, text: "Octopuses have three hearts and blue blood.", category: "animals" },
  { id: 3, text: "Honeybees communicate the location of flowers through a waggle dance.", category: "animals" },
  { id: 4, text: "Emperor penguins huddle together to survive the Antarctic winter.", category: "animals" },
  { id: 5, text: "A group of crows is called a murder.", category: "animals" },

  // technology
  { id: 6, text: "A vector database stores embeddings and finds nearest neighbours by distance.", category: "technology" },
  { id: 7, text: "Solid-state drives have no moving parts and are far faster than hard disks.", category: "technology" },
  { id: 8, text: "Public-key cryptography lets two strangers exchange secrets over an open channel.", category: "technology" },
  { id: 9, text: "Transformers replaced recurrent networks for most language tasks.", category: "technology" },
  { id: 10, text: "Bluetooth Low Energy is designed for small bursts of data and long battery life.", category: "technology" },

  // food
  { id: 11, text: "Sourdough bread rises using wild yeast and lactic acid bacteria.", category: "food" },
  { id: 12, text: "Dark chocolate contains flavonoids that may benefit heart health.", category: "food" },
  { id: 13, text: "Sushi rice is seasoned with rice vinegar, sugar, and salt.", category: "food" },
  { id: 14, text: "Capsaicin is the compound that makes chilli peppers taste hot.", category: "food" },
  { id: 15, text: "Parmesan cheese is aged for at least twelve months before sale.", category: "food" },

  // places
  { id: 16, text: "Mount Everest is the highest mountain above sea level on Earth.", category: "places" },
  { id: 17, text: "Venice is built on more than a hundred small islands in a lagoon.", category: "places" },
  { id: 18, text: "The Sahara is the largest hot desert in the world.", category: "places" },
  { id: 19, text: "Iceland sits on the boundary of two tectonic plates and is full of volcanoes.", category: "places" },
  { id: 20, text: "Tokyo is the most populous metropolitan area on the planet.", category: "places" },

  // space
  { id: 21, text: "A light-year is the distance light travels in one year, about 9.5 trillion km.", category: "space" },
  { id: 22, text: "Jupiter is the largest planet and has a storm called the Great Red Spot.", category: "space" },
  { id: 23, text: "Black holes have gravity so strong that not even light can escape.", category: "space" },
  { id: 24, text: "The Moon is slowly drifting away from Earth by about 3.8 cm per year.", category: "space" },
  { id: 25, text: "Saturn's rings are made mostly of ice and rock particles.", category: "space" },

  // history
  { id: 26, text: "The printing press was invented by Johannes Gutenberg around 1440.", category: "history" },
  { id: 27, text: "The Great Wall of China was built over many centuries by successive dynasties.", category: "history" },
  { id: 28, text: "The Rosetta Stone was the key to deciphering Egyptian hieroglyphs.", category: "history" },
  { id: 29, text: "The first ever email was sent in 1971 by Ray Tomlinson.", category: "history" },
  { id: 30, text: "The Wright brothers made the first powered flight in 1903.", category: "history" },
];
