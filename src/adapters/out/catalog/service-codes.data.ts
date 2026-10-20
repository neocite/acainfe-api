/**
 * Subconjunto curado da lista de serviços da LC 116/2003 com o código de tributação nacional (cTribNac)
 * mais comum para PMEs. Não substitui a tabela oficial completa — a validade do código no município
 * é confirmada via parametrização municipal (GET /v1/municipal-params/:code).
 * Formato: [cTribNac, item LC 116, descrição]
 */
export const SERVICE_CODES: [string, string, string][] = [
  ['010101', '1.01', 'Análise e desenvolvimento de sistemas'],
  ['010201', '1.02', 'Programação'],
  [
    '010301',
    '1.03',
    'Processamento, armazenamento ou hospedagem de dados, textos, imagens, vídeos, páginas eletrônicas, aplicativos e sistemas de informação',
  ],
  ['010401', '1.04', 'Elaboração de programas de computadores, inclusive de jogos eletrônicos'],
  ['010501', '1.05', 'Licenciamento ou cessão de direito de uso de programas de computação'],
  ['010601', '1.06', 'Assessoria e consultoria em informática'],
  [
    '010701',
    '1.07',
    'Suporte técnico em informática, inclusive instalação, configuração e manutenção de programas',
  ],
  ['010801', '1.08', 'Planejamento, confecção, manutenção e atualização de páginas eletrônicas'],
  [
    '010901',
    '1.09',
    'Disponibilização, sem cessão definitiva, de conteúdos de áudio, vídeo, imagem e texto pela internet (streaming)',
  ],
  ['020101', '2.01', 'Serviços de pesquisas e desenvolvimento de qualquer natureza'],
  ['040101', '4.01', 'Medicina e biomedicina'],
  ['040301', '4.03', 'Hospitais, clínicas, laboratórios, sanatórios, ambulatórios e congêneres'],
  ['040801', '4.08', 'Terapia ocupacional, fisioterapia e fonoaudiologia'],
  ['041201', '4.12', 'Odontologia'],
  ['041301', '4.13', 'Ortóptica'],
  ['041601', '4.16', 'Psicologia'],
  ['050101', '5.01', 'Medicina veterinária e zootecnia'],
  ['060101', '6.01', 'Barbearia, cabeleireiros, manicuros, pedicuros e congêneres'],
  ['060201', '6.02', 'Esteticistas, tratamento de pele, depilação e congêneres'],
  [
    '060401',
    '6.04',
    'Ginástica, dança, esportes, natação, artes marciais e demais atividades físicas',
  ],
  [
    '070201',
    '7.02',
    'Execução de obras de construção civil, hidráulica ou elétrica (por administração, empreitada ou subempreitada)',
  ],
  [
    '071001',
    '7.10',
    'Limpeza, manutenção e conservação de vias, logradouros, imóveis, chaminés, piscinas, parques e congêneres',
  ],
  ['080101', '8.01', 'Ensino regular pré-escolar, fundamental, médio e superior'],
  [
    '080201',
    '8.02',
    'Instrução, treinamento, orientação pedagógica e educacional, avaliação de conhecimentos de qualquer natureza',
  ],
  [
    '100201',
    '10.02',
    'Agenciamento, corretagem ou intermediação de títulos em geral, valores mobiliários e contratos quaisquer',
  ],
  ['100501', '10.05', 'Agenciamento, corretagem ou intermediação de bens móveis ou imóveis'],
  ['110201', '11.02', 'Vigilância, segurança ou monitoramento de bens, pessoas e semoventes'],
  ['120101', '12.01', 'Espetáculos teatrais'],
  ['120801', '12.08', 'Feiras, exposições, congressos e congêneres'],
  [
    '130301',
    '13.03',
    'Fotografia e cinematografia, inclusive revelação, ampliação, cópia, reprodução, trucagem e congêneres',
  ],
  [
    '140101',
    '14.01',
    'Lubrificação, limpeza, lustração, revisão, carga e recarga, conserto, restauração, blindagem, manutenção e conservação de máquinas, veículos, aparelhos e equipamentos',
  ],
  ['140601', '14.06', 'Instalação e montagem de aparelhos, máquinas e equipamentos'],
  [
    '170101',
    '17.01',
    'Assessoria ou consultoria de qualquer natureza, não contida em outros itens desta lista',
  ],
  [
    '170201',
    '17.02',
    'Datilografia, digitação, estenografia, expediente, secretaria em geral, apoio e infraestrutura administrativa',
  ],
  [
    '170301',
    '17.03',
    'Planejamento, coordenação, programação ou organização técnica, financeira ou administrativa',
  ],
  [
    '170601',
    '17.06',
    'Propaganda e publicidade, inclusive promoção de vendas, planejamento de campanhas ou sistemas de publicidade',
  ],
  ['170901', '17.09', 'Perícias, laudos, exames técnicos e análises técnicas'],
  ['171201', '17.12', 'Administração em geral, inclusive de bens e negócios de terceiros'],
  ['171401', '17.14', 'Advocacia'],
  ['171901', '17.19', 'Contabilidade, inclusive serviços técnicos e auxiliares'],
  ['172001', '17.20', 'Consultoria e assessoria econômica ou financeira'],
  [
    '172301',
    '17.23',
    'Assessoria, análise, avaliação, atendimento, consulta, cadastro, seleção, gerenciamento de informações, administração de contas a receber ou a pagar e em geral, relacionados a operações de faturização',
  ],
  ['172401', '17.24', 'Apresentação de palestras, conferências, seminários e congêneres'],
  [
    '230101',
    '23.01',
    'Serviços de programação e comunicação visual, desenho industrial e congêneres',
  ],
  [
    '240101',
    '24.01',
    'Serviços de chaveiros, confecção de carimbos, placas, sinalização visual, banners, adesivos e congêneres',
  ],
  ['250101', '25.01', 'Funerais, inclusive fornecimento de caixão, urna ou esquifes'],
  [
    '260101',
    '26.01',
    'Serviços de coleta, remessa ou entrega de correspondências, documentos, objetos, bens ou valores',
  ],
  [
    '310101',
    '31.01',
    'Serviços técnicos em edificações, eletrônica, eletrotécnica, mecânica, telecomunicações e congêneres',
  ],
  ['320101', '32.01', 'Serviços de desenhos técnicos'],
  [
    '350101',
    '35.01',
    'Serviços de reportagem, assessoria de imprensa, jornalismo e relações públicas',
  ],
  ['370101', '37.01', 'Serviços de artistas, atletas, modelos e manequins'],
  ['390101', '39.01', 'Serviços de ourivesaria e lapidação'],
];
