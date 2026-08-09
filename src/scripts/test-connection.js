import { supabase } from '../lib/supabase.js';

const { data, error } = await supabase.from('doctors').select('*');

if (error) {
  console.error('Erro:', error.message);
  process.exit(1);
}

console.log('Conexao OK! Medicos encontrados:', data.length);
data.forEach((d) => console.log(' -', d.nome));