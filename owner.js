// owner.js
const fs = require('fs');
const PATH = './owner.json';

function ensureFile() {
  if (!fs.existsSync(PATH)) {
    fs.writeFileSync(PATH, JSON.stringify({ owners: [] }, null, 2));
  }
}

function loadOwners() {
  ensureFile();
  const raw = fs.readFileSync(PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.owners) ? parsed.owners.map(n => Number(n)) : [];
  } catch (e) {
    return [];
  }
}
function saveOwners(list) {
  ensureFile();
  fs.writeFileSync(PATH, JSON.stringify({ owners: list }, null, 2));
}
function isOwner(userId) {
  const owners = loadOwners();
  return owners.includes(Number(userId));
}
function addOwner(userId) {
  const owners = loadOwners();
  if (!owners.includes(Number(userId))) {
    owners.push(Number(userId));
    saveOwners(owners);
    return true;
  }
  return false;
}
function delOwner(userId) {
  const owners = loadOwners();
  const filtered = owners.filter(id => id !== Number(userId));
  saveOwners(filtered);
  return owners.length !== filtered.length;
}

module.exports = { loadOwners, saveOwners, isOwner, addOwner, delOwner };